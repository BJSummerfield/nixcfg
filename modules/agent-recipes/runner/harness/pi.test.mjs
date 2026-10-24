import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piArgv, start } from "./pi.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pi-"));
const fakes = path.join(tmp, "fakes");
fs.mkdirSync(fakes);

fs.writeFileSync(
  path.join(fakes, "ok.mjs"),
  `import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv, stdin, cwd: process.cwd(), pid: process.pid,
  env: { RECIPE_CHILD: process.env.RECIPE_CHILD, EXTRA: process.env.EXTRA },
}));
const dir = flag("--session-dir");
if (dir) {
  const folder = path.join(dir, "--work--");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "2026-10-24T00-00-00-000Z_" + flag("--session-id") + ".jsonl"), "");
}
const usage = (fields) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...fields });
const assistant = (fields) => ({ type: "message_end", message: { role: "assistant", ...fields } });
const lines = [
  { type: "session", version: 3, id: "x", cwd: process.cwd() },
  { type: "message_end", message: { role: "user", content: "go" } },
  { type: "message_update", usage: usage({ input: 1 }), assistantMessageEvent: { type: "text_delta", delta: "n" } },
  assistant({
    content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }],
    usage: usage({ input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165 }),
    stopReason: "toolUse",
  }),
  { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file " }, { type: "text", text: "body" }], isError: false } },
  { type: "compaction_end", reason: "threshold", result: { summary: "s" }, aborted: false },
  { type: "compaction_end", reason: "threshold", aborted: true },
  assistant({
    content: [{ type: "text", text: "Done" }, { type: "text", text: "line\\u2028two" }],
    usage: usage({ input: 20, output: 30, cacheRead: 200 }),
    stopReason: "stop",
  }),
  { type: "agent_settled", aborted: false },
];
process.stdout.write("not json at all\\r\\n");
for (const [index, line] of lines.entries()) {
  const text = JSON.stringify(line) + "\\n";
  if (index === 7) {
    const middle = Math.floor(text.length / 2);
    process.stdout.write(text.slice(0, middle));
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.stdout.write(text.slice(middle));
  } else {
    process.stdout.write(text);
  }
}
process.stderr.write("warning from pi\\n");
`,
);

fs.writeFileSync(
  path.join(fakes, "hang.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_RECORD, String(grandchild.pid));
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
setTimeout(() => {}, 60000);
`,
);

fs.writeFileSync(
  path.join(fakes, "boom.mjs"),
  `process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 }, stopReason: "error", errorMessage: "boom" } }) + "\\n");
process.exit(1);
`,
);

fs.writeFileSync(
  path.join(fakes, "long.mjs"),
  `process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "cut off" }], usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 }, stopReason: "length" } }) + "\\n");
`,
);

fs.writeFileSync(
  path.join(fakes, "silent.mjs"),
  `process.stderr.write("could not load model\\n");
process.stdout.write(JSON.stringify({ type: "session", id: "x" }) + "\\n");
`,
);

const stubHead = `const usage = (total) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total });
const assistant = (content, total, stopReason = "toolUse") => ({ type: "message_end", message: { role: "assistant", content, usage: usage(total), stopReason } });
const call = (name, args = {}) => ({ type: "toolCall", id: name, name, arguments: args });
`;
const stubTail = `for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
`;

fs.writeFileSync(
  path.join(fakes, "valve.mjs"),
  stubHead + `const entry = (data) => ({ type: "entry_appended", entry: { customType: "budget-valve", data } });
const lines = [
  assistant([call("read")], 9000),
  assistant([call("write")], 31000),
  assistant([call("write")], 40000),
  { type: "entry_appended", entry: { customType: "other", data: { kind: "handoff" } } },
  entry({ kind: "handoff", role: "worker", action: "commit and write a note", budget: 30000, reserve: 5000, tokens: 40000 }),
  entry({ kind: "ended", role: "worker" }),
  assistant([{ type: "text", text: "bye" }], 41000, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "commit.mjs"),
  stubHead + `const lines = [
  assistant([call("bash", { command: "ls" })], 5000),
  assistant([call("bash", { command: "git commit -m x" })], 12000),
  assistant([{ type: "text", text: "bye" }], 20000, "stop"),
];
` + stubTail,
);

const fake = (name) => [process.execPath, path.join(fakes, `${name}.mjs`)];

function specFor(label, overrides = {}) {
  const base = path.join(tmp, label);
  return {
    runId: `r1-${label}`,
    roleName: "worker",
    role: { prompt: "You are a worker.", thinking: "high", tools: ["read", "bash"] },
    model: "redtruck/qwen",
    extensions: ["/ext/a.js", "/ext/b.js"],
    brief: "Do the thing.",
    cwd: tmp,
    sessionDir: path.join(base, "sessions"),
    sessionId: `r1-${label}`,
    resume: false,
    timeoutMs: 20000,
    env: { EXTRA: "yes" },
    logDir: path.join(base, "log"),
    transcriptFile: path.join(base, "transcripts", `${label}.jsonl`),
    bin: fake("ok"),
    ...overrides,
    record: path.join(base, "record.json"),
  };
}

const run = (spec) => {
  fs.mkdirSync(path.dirname(spec.record), { recursive: true });
  return start({ ...spec, env: { ...spec.env, FAKE_RECORD: spec.record } });
};

// argv forms
{
  const spec = specFor("argv");
  assert.deepEqual(piArgv(spec), [
    "--mode", "json", "--no-skills", "--no-prompt-templates",
    "--system-prompt", "You are a worker.",
    "--model", "redtruck/qwen",
    "--thinking", "high",
    "--tools", "read,bash",
    "-e", "/ext/a.js", "-e", "/ext/b.js",
    "--session-dir", spec.sessionDir, "--session-id", "r1-argv",
  ]);
  const resumed = piArgv({ ...spec, runId: "r2-argv", resume: true, sessionFile: "/s/old_r1-argv.jsonl" });
  assert.deepEqual(resumed.slice(-2), ["--session", "/s/old_r1-argv.jsonl"]);
  assert.ok(!resumed.includes("--session-dir") && !resumed.includes("--session-id"));
  assert.ok(!piArgv(spec).includes(spec.brief));
  assert.ok(!piArgv({ ...spec, role: { prompt: "p" }, model: undefined }).some((a) => ["--tools", "--model", "--thinking"].includes(a)));
}

// a normal run, then a resumed one on the same session
{
  const spec = specFor("ok");
  const spawned = [];
  const outcome = await run({ ...spec, onSpawn: (info) => spawned.push(info) });
  const record = JSON.parse(fs.readFileSync(spec.record, "utf8"));

  assert.equal(outcome.status, "done");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stopReason, "stop");
  assert.equal(outcome.finalText, "Done\nline two");
  assert.deepEqual(outcome.usage, { prompt: 375, cached: 250, output: 40, peakContext: 250, firstContext: 250, turns: 2, compactions: 1 });
  assert.equal(outcome.valve, null);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].pid, record.pid);
  assert.deepEqual(record.argv, piArgv(spec));
  assert.equal(record.stdin, "Do the thing.");
  assert.equal(record.cwd, fs.realpathSync(tmp));
  assert.deepEqual(record.env, { RECIPE_CHILD: "1", EXTRA: "yes" });
  assert.equal(
    outcome.sessionFile,
    path.join(spec.sessionDir, "--work--", "2026-10-24T00-00-00-000Z_r1-ok.jsonl"),
  );

  const events = fs.readFileSync(path.join(spec.logDir, "events.jsonl"), "utf8").split("\n");
  assert.equal(events.pop(), "");
  assert.equal(events[0], "not json at all");
  assert.equal(events.length, 10);
  const split = events.find((line) => line.includes("line\\u2028two") || line.includes("line two"));
  assert.equal(JSON.parse(split).message.content[1].text, "line two");
  assert.equal(fs.readFileSync(path.join(spec.logDir, "stderr.log"), "utf8"), "warning from pi\n");

  const transcript = fs.readFileSync(spec.transcriptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    transcript.map((r) => [r.recordType, r.message.role]),
    [["message", "user"], ["message", "assistant"], ["message", "toolResult"], ["message", "assistant"]],
  );
  assert.equal(transcript[2].toolName, "read");
  assert.equal(transcript[2].text, "file \nbody");
  assert.equal(transcript[1].toolName, undefined);

  const resumedSpec = {
    ...spec,
    runId: "r2-ok",
    resume: true,
    sessionFile: outcome.sessionFile,
    logDir: path.join(tmp, "ok", "log2"),
    record: path.join(tmp, "ok", "record2.json"),
  };
  const again = await run(resumedSpec);
  const resumedRecord = JSON.parse(fs.readFileSync(resumedSpec.record, "utf8"));
  assert.equal(again.status, "done");
  assert.deepEqual(resumedRecord.argv.slice(-2), ["--session", outcome.sessionFile]);
  assert.equal(resumedRecord.stdin, "Do the thing.");
  assert.ok(!resumedRecord.argv.includes("--session-id"));
  assert.equal(again.sessionFile, outcome.sessionFile);
}

// the valve's entries, and the context at the first write
{
  const spec = specFor("valve", { bin: fake("valve") });
  const outcome = await run(spec);
  assert.equal(outcome.status, "done");
  assert.deepEqual(outcome.valve, { fired: true, tokens: 40000, budget: 30000, action: "commit and write a note", ended: true });
  assert.equal(outcome.usage.firstContext, 31000);
  assert.equal(outcome.usage.peakContext, 41000);
  const transcript = fs.readFileSync(spec.transcriptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const valves = transcript.filter((r) => r.recordType === "valve");
  assert.deepEqual(valves.map((r) => r.data.kind), ["handoff", "ended"]);
  assert.equal(valves[0].data.tokens, 40000);

  const committed = await run(specFor("commit", { bin: fake("commit") }));
  assert.equal(committed.usage.firstContext, 12000);
  assert.equal(committed.valve, null);
}

// a brief that starts with "@" or "-", or is far larger than one argument can be, arrives intact
{
  for (const [label, brief] of [
    ["at", "@notes.md is the file\nand more"],
    ["dash", "--help me"],
    ["big", `@${"x".repeat(300 * 1024)}\nend`],
  ]) {
    const spec = specFor(`brief-${label}`, { brief });
    const outcome = await run(spec);
    assert.equal(outcome.status, "done");
    const record = JSON.parse(fs.readFileSync(spec.record, "utf8"));
    assert.equal(record.stdin, brief);
    assert.ok(record.argv.every((a) => a.length < 4096));
  }
}

// a deadline kills the whole tree
{
  const spec = specFor("hang", { bin: fake("hang"), timeoutMs: 500 });
  const startedAt = Date.now();
  const outcome = await run(spec);
  const grandchild = Number(fs.readFileSync(spec.record, "utf8"));
  assert.equal(outcome.status, "timeout");
  assert.ok(Date.now() - startedAt < 15000);
  assert.ok(!alive(grandchild), "grandchild survived the timeout");
  assert.ok(grandchild > 0);
}

// an abort signal kills the tree, and an already aborted signal starts nothing
{
  const controller = new AbortController();
  const spec = specFor("abort", { bin: fake("hang"), signal: controller.signal });
  setTimeout(() => controller.abort(), 400);
  const outcome = await run(spec);
  assert.equal(outcome.status, "aborted");
  assert.ok(!alive(Number(fs.readFileSync(spec.record, "utf8"))));

  const pre = specFor("preabort", { bin: fake("hang"), signal: AbortSignal.abort() });
  const none = await run(pre);
  assert.equal(none.status, "aborted");
  assert.ok(!fs.existsSync(pre.record));
}

// failures
{
  const boom = await run(specFor("boom", { bin: fake("boom") }));
  assert.equal(boom.status, "failed");
  assert.equal(boom.exitCode, 1);
  assert.equal(boom.stopReason, "error");
  assert.equal(boom.error, "boom");
  assert.equal(boom.usage.turns, 1);

  const silent = await run(specFor("silent", { bin: fake("silent") }));
  assert.equal(silent.status, "failed");
  assert.equal(silent.error, "could not load model");

  const truncated = await run(specFor("long", { bin: fake("long") }));
  assert.equal(truncated.status, "failed");
  assert.equal(truncated.stopReason, "length");
  assert.equal(truncated.error, "output limit reached");
  assert.equal(truncated.finalText, "cut off");

  const noSession = specFor("nosession", { resume: true, sessionFile: undefined });
  const lost = await run(noSession);
  assert.equal(lost.status, "failed");
  assert.equal(lost.error, "no session file to resume");
  assert.ok(!fs.existsSync(noSession.logDir));

  const missing = await run(specFor("missing", { bin: [path.join(tmp, "no-such-pi")] }));
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /ENOENT/);
}

// the binary can come from RECIPE_PI_BIN
{
  process.env.RECIPE_PI_BIN = JSON.stringify(fake("ok"));
  const spec = specFor("envbin", { bin: undefined });
  const outcome = await run(spec);
  delete process.env.RECIPE_PI_BIN;
  assert.equal(outcome.status, "done");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok");
