import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handoffPrompt } from "../handoff.mjs";
import { LOOP_REPEATS, piArgv, start } from "./pi.mjs";

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
  path.join(fakes, "budget.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const resumed = argv.includes("--session");
const lingers = !resumed || process.env.FAKE_MODE !== "loops";
const grandchild = lingers
  ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" })
  : null;
fs.writeFileSync(process.env.FAKE_RECORD + (resumed ? ".2" : ".1"), JSON.stringify({
  argv, stdin, pid: process.pid, grandchild: grandchild?.pid,
  env: { RECIPE_CHILD: process.env.RECIPE_CHILD, EXTRA: process.env.EXTRA, RECIPE_HANDOFF_GUARD: process.env.RECIPE_HANDOFF_GUARD },
}));
const dir = flag("--session-dir");
if (dir) {
  const folder = path.join(dir, "--work--");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "2026-10-24T00-00-00-000Z_" + flag("--session-id") + ".jsonl"), "");
}
const usage = (fields) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...fields });
const assistant = (content, u, stopReason = "toolUse") => ({ type: "message_end", message: { role: "assistant", content, usage: u, stopReason } });
const result = (id, name, isError = false) => ({
  type: "message_end",
  message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: isError ? "refused" : "ok" }], isError },
});
const turnEnd = (message, results) => ({ type: "turn_end", message, toolResults: results.map((r) => r.message) });
const lines = [];
if (!resumed) {
  const t1 = assistant(
    [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
    usage({ input: 10, output: 90, cacheRead: 900, totalTokens: 1000 }),
  );
  const r1 = result("c1", "bash");
  const t2 = assistant(
    [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "pwd" } }],
    usage({ input: 5, output: 195, cacheRead: 5800, totalTokens: 6000 }),
  );
  const r2 = result("c2", "bash");
  lines.push(
    { type: "session", version: 3, id: "x", cwd: process.cwd() },
    { type: "message_end", message: { role: "user", content: "go" } },
    t1, r1, turnEnd(t1.message, [r1]),
    t2, r2, turnEnd(t2.message, [r2]),
  );
} else if (process.env.FAKE_MODE === "") {
  const output = process.env.RECIPE_OUTPUT;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, "handoff: wrote the note and committed\\n");
  const a = assistant(
    [
      { type: "toolCall", id: "w1", name: "write", arguments: { path: output } },
      { type: "toolCall", id: "b1", name: "bash", arguments: { command: "git commit -m handoff" } },
    ],
    usage({ input: 100, output: 200, cacheRead: 5900, totalTokens: 6200 }),
  );
  const rw = result("w1", "write");
  const rb = result("b1", "bash");
  lines.push(a, rw, rb, turnEnd(a.message, [rw, rb]));
} else if (process.env.FAKE_MODE === "loops") {
  for (let i = 0; i < 4; i++) {
    const a = assistant(
      [{ type: "toolCall", id: "h" + i, name: "bash", arguments: { command: "ls" } }],
      usage({ input: 1100 + i, totalTokens: 1100 + i }),
    );
    const r = result("h" + i, "bash", true);
    lines.push(a, r, turnEnd(a.message, [r]));
  }
  lines.push(
    assistant([{ type: "text", text: "bye" }], usage({ input: 1200, totalTokens: 1200 }), "stop"),
    { type: "agent_settled", aborted: false },
  );
}
for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
if (lingers) setTimeout(() => {}, 60000);
`,
);

fs.writeFileSync(
  path.join(fakes, "thrash.mjs"),
  `import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(process.env.FAKE_RECORD + ".1", JSON.stringify({
  argv, stdin, pid: process.pid,
  env: { RECIPE_CHILD: process.env.RECIPE_CHILD, EXTRA: process.env.EXTRA, RECIPE_HANDOFF_GUARD: process.env.RECIPE_HANDOFF_GUARD },
}));
const dir = flag("--session-dir");
if (dir) {
  const folder = path.join(dir, "--work--");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "2026-10-24T00-00-00-000Z_" + flag("--session-id") + ".jsonl"), "");
}
const usage = (fields) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...fields });
const assistant = (content, u, stopReason = "toolUse") => ({ type: "message_end", message: { role: "assistant", content, usage: u, stopReason } });
const result = (id, name) => ({
  type: "message_end",
  message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false },
});
const turnEnd = (message, results) => ({ type: "turn_end", message, toolResults: results.map((r) => r.message) });
const t1 = assistant(
  [{ type: "toolCall", id: "r1", name: "read", arguments: {} }],
  usage({ input: 100, output: 900, totalTokens: 1000 }),
);
const r1 = result("r1", "read");
const t2 = assistant(
  [{ type: "toolCall", id: "r2", name: "read", arguments: {} }],
  usage({ input: 100, output: 900, cacheRead: 5000, totalTokens: 6000 }),
);
const r2 = result("r2", "read");
const lines = [
  { type: "session", version: 3, id: "x", cwd: process.cwd() },
  { type: "message_end", message: { role: "user", content: "go" } },
  t1, r1, turnEnd(t1.message, [r1]),
  { type: "message_end", message: { role: "custom", customType: "budget-valve-thrash", content: [{ type: "text", text: "not converging" }], display: true } },
  t2, r2, turnEnd(t2.message, [r2]),
  assistant([{ type: "text", text: "FAILED: compaction thrash" }], usage({ input: 1, totalTokens: 1 }), "stop"),
  { type: "agent_settled", aborted: false },
];
for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
`,
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

fs.writeFileSync(
  path.join(fakes, "deltas.mjs"),
  stubHead + `const lines = [{ type: "session", id: "x" }];
for (let turn = 0; turn < 3; turn++) {
  lines.push({ type: "message_start", message: { role: "assistant" } });
  for (let i = 0; i < 200; i++) {
    lines.push({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(i) }] }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
    if (i % 50 === 0) lines.push({ type: "tool_execution_update", toolCallId: "c", partialResult: "p".repeat(i) });
  }
  lines.push(assistant([turn < 2 ? call("read") : { type: "text", text: "done" }], 1000 + turn, turn < 2 ? "toolUse" : "stop"));
  lines.push({ type: "tool_execution_end", toolCallId: "c" });
}
lines.push({ type: "entry_appended", entry: { customType: "budget-valve", data: { kind: "ended" } } });
lines.push({ type: "compaction_start" });
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "looped.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_RECORD, String(grandchild.pid));
${stubHead}const lines = [
  assistant([{ type: "text", text: "done" }], 100, "stop"),
  ...[0, 1, 2, 3].flatMap(() => [
    assistant([call("bash", { command: "ls" })], 100),
    { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "no change" }], isError: true } },
  ]),
];
for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
setTimeout(() => {}, 60000);
`,
);

fs.writeFileSync(
  path.join(fakes, "loop-recovered.mjs"),
  stubHead + `const lines = [
  ...[0, 1, 2].flatMap(() => [
    assistant([call("bash", { command: "ls" })], 100),
    { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "no change" }], isError: true } },
  ]),
  assistant([call("bash", { command: "pwd" })], 100),
  { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "/x" }], isError: false } },
  assistant([{ type: "text", text: "ok" }], 100, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "loop-poll.mjs"),
  stubHead + `const lines = [
  ...[0, 1, 2, 3, 4, 5].map((i) => [
    assistant([call("bash", { command: "poll" })], 100),
    { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "state " + i }], isError: false } },
  ]).flat(),
  assistant([{ type: "text", text: "ready" }], 100, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "loop-interleaved.mjs"),
  stubHead + `const test = () => [
  assistant([call("bash", { command: "npm test" })], 100),
  { type: "message_end", message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "1 failing" }], isError: true } },
];
const edit = () => [
  assistant([call("edit", { path: "x.js" })], 100),
  { type: "message_end", message: { role: "toolResult", toolCallId: "e", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false } },
];
const lines = [
  ...test(), ...edit(), ...test(), ...edit(), ...test(), ...edit(), ...test(),
  assistant([{ type: "text", text: "ok" }], 100, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "loop-reset.mjs"),
  stubHead + `const turn = () => [
  assistant([call("bash", { command: "ls" })], 100),
  { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "no change" }], isError: true } },
];
const lines = [
  ...turn(),
  assistant([{ type: "text", text: "working" }], 100, "length"),
  ...turn(), ...turn(), ...turn(),
  assistant([{ type: "text", text: "all done" }], 100, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "loop-reset-user.mjs"),
  stubHead + `const turn = () => [
  assistant([call("bash", { command: "ls" })], 100),
  { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "no change" }], isError: true } },
];
const lines = [
  ...turn(), ...turn(),
  { type: "message_end", message: { role: "user", content: "again" } },
  ...turn(), ...turn(), ...turn(),
  assistant([{ type: "text", text: "all done" }], 100, "stop"),
];
` + stubTail,
);

fs.writeFileSync(
  path.join(fakes, "looped-text.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_RECORD, String(grandchild.pid));
${stubHead}const lines = [
  ...[0, 1, 2, 3].flatMap(() => [
    assistant([{ type: "text", text: "done" }, call("bash", { command: "ls" })], 100),
    { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "no change" }], isError: true } },
  ]),
];
for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
setTimeout(() => {}, 60000);
`,
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

const budgetSpec = (label, mode, overrides = {}) => {
  const spec = specFor(label, {
    bin: fake("budget"),
    budget: { tokens: 5000, reserve: 10000, action: "commit" },
    item: { output: path.join(tmp, label, "notes", "note.md") },
    ...overrides,
  });
  return { ...spec, env: { ...spec.env, FAKE_MODE: mode, ...(spec.item?.output ? { RECIPE_OUTPUT: spec.item.output } : {}) } };
};
const records = (spec) => [1, 2].map((n) => {
  const file = `${spec.record}.${n}`;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
});
const gone = (record) => {
  if (!record) return;
  assert.ok(!alive(record.pid) && !(record.grandchild && alive(record.grandchild)), "a process survived");
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
  assert.equal(events.length, 9);
  assert.ok(!events.some((line) => line.includes("message_update")));
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

// a stream of deltas leaves one events line per finished message, and the other events stay
{
  const spec = specFor("deltas", { bin: fake("deltas") });
  const outcome = await run(spec);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.usage.turns, 3);
  const events = fs.readFileSync(path.join(spec.logDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "session",
      ...[0, 1, 2].flatMap(() => ["message_start", "message_end", "tool_execution_end"]),
      "entry_appended",
      "compaction_start",
    ],
  );
}

// each process a child ran is recorded with its argv and RECIPE_* variables, never the brief
{
  const spec = specFor("spawnlog", { env: { EXTRA: "yes", RECIPE_ROLE: "worker", RECIPE_BUDGET_TOKENS: "100000" } });
  await run(spec);
  const lines = fs.readFileSync(path.join(spec.logDir, "spawn.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].command, process.execPath);
  assert.deepEqual(lines[0].argv.slice(1), piArgv(spec));
  assert.equal(lines[0].cwd, spec.cwd);
  assert.equal(lines[0].env.RECIPE_ROLE, "worker");
  assert.equal(lines[0].env.RECIPE_BUDGET_TOKENS, "100000");
  assert.equal(lines[0].env.RECIPE_CHILD, "1");
  assert.ok(Object.keys(lines[0].env).every((name) => name.startsWith("RECIPE_")));
  assert.ok(!JSON.stringify(lines[0]).includes(spec.brief));
}

// a budget hit at a tool-call turn hands off, and the handoff ends with the note and the commit
{
  const spec = budgetSpec("budget-commit", "");
  const spawned = [];
  const started = Date.now();
  const outcome = await run({ ...spec, onSpawn: (info) => spawned.push(info.pid) });
  assert.ok(Date.now() - started < 15000);
  const [first, second] = records(spec);
  const session = path.join(spec.sessionDir, "--work--", "2026-10-24T00-00-00-000Z_r1-budget-commit.jsonl");
  assert.equal(outcome.status, "budget");
  assert.equal(outcome.finalText, "");
  assert.deepEqual(outcome.valve, { fired: true, tokens: 6000, budget: 5000, action: "commit", ended: true });
  assert.deepEqual(outcome.usage, { prompt: 12715, cached: 12600, output: 485, peakContext: 6200, firstContext: 6200, turns: 3, compactions: 0 });
  assert.equal(outcome.sessionFile, session);
  assert.deepEqual(spawned, [first.pid, second.pid]);
  gone(first);
  gone(second);
  assert.deepEqual(first.argv.slice(-4), ["--session-dir", spec.sessionDir, "--session-id", "r1-budget-commit"]);
  assert.equal(first.stdin, "Do the thing.");
  assert.deepEqual(first.env, { RECIPE_CHILD: "1", EXTRA: "yes" });
  assert.deepEqual(second.argv.slice(-2), ["--session", session]);
  assert.deepEqual(second.argv.slice(0, -2), first.argv.slice(0, -4));
  assert.ok(!second.argv.includes("--session-dir") && !second.argv.includes("--session-id"));
  assert.equal(second.env.RECIPE_HANDOFF_GUARD, "1");
  assert.equal(second.stdin, handoffPrompt("commit", { output: spec.item.output, tokens: 6000 }));
  assert.ok(fs.readFileSync(spec.item.output, "utf8").startsWith("handoff: "));
  const transcript = fs.readFileSync(spec.transcriptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const c2 = transcript.find((r) => r.recordType === "message" && r.message.role === "toolResult" && r.message.toolCallId === "c2");
  assert.ok(c2, "the c2 tool result is in the transcript");
}

// a thrash message stops the trigger, so the valve's ending never hands off
{
  const spec = budgetSpec("thrash", "", { bin: fake("thrash") });
  const outcome = await run(spec);
  const [first, second] = records(spec);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.valve, null);
  assert.equal(outcome.finalText, "FAILED: compaction thrash");
  assert.equal(second, null);
  gone(first);
}

// an abort during the handoff turn reports aborted
{
  const controller = new AbortController();
  const spec = budgetSpec("budget-abort", "hang2", { signal: controller.signal });
  let spawns = 0;
  const outcome = await run({
    ...spec,
    onSpawn: () => {
      spawns += 1;
      if (spawns === 2) setTimeout(() => controller.abort(), 300);
    },
  });
  const [first, second] = records(spec);
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.valve.fired, true);
  assert.equal(outcome.valve.ended, false);
  gone(first);
  gone(second);
}

// the handoff has its own, shorter deadline
{
  const spec = budgetSpec("budget-timeout", "hang2", { handoffTimeoutMs: 1500 });
  const outcome = await run(spec);
  const [first, second] = records(spec);
  assert.equal(outcome.status, "timeout");
  assert.match(outcome.error, /timed out after 1500ms/);
  gone(first);
  gone(second);
}

// no budget, and a zero one, never trigger
{
  for (const [label, budget] of [
    ["budget-null", null],
    ["budget-zero", { tokens: 0, reserve: 0, action: "stop" }],
  ]) {
    const spec = budgetSpec(label, "", { budget, timeoutMs: 1500 });
    const outcome = await run(spec);
    const [first, second] = records(spec);
    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.valve, null);
    assert.equal(second, null);
    gone(first);
  }
}

// the context at the first write
{
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

// a model that repeats the same turn with the same result is ended
{
  const spec = specFor("looped", { bin: fake("looped") });
  const outcome = await run(spec);
  assert.equal(LOOP_REPEATS, 4);
  assert.equal(outcome.status, "looped");
  assert.equal(outcome.error, "repeated bash 4 times with the same result");
  assert.deepEqual(outcome.loop, { tool: "bash", repeats: 4 });
  assert.equal(outcome.finalText, "");
  assert.ok(!alive(Number(fs.readFileSync(spec.record, "utf8"))), "looped child survived");
}

// three identical turns, then a different one, then a turn without calls end done
{
  const outcome = await run(specFor("loop-recovered", { bin: fake("loop-recovered") }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
}

// the same call with a different result each time does not trip
{
  const outcome = await run(specFor("loop-poll", { bin: fake("loop-poll") }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
}

// the same call repeated after a different turn does not trip
{
  const outcome = await run(specFor("loop-interleaved", { bin: fake("loop-interleaved") }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
}

// a reply without tool calls breaks the run of identical turns
{
  const outcome = await run(specFor("loop-reset", { bin: fake("loop-reset") }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
}

// a user message breaks the run of identical turns
{
  const outcome = await run(specFor("loop-reset-user", { bin: fake("loop-reset-user") }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
}

// the same looping turn with text in every message ends looped, keeping the text
{
  const spec = specFor("looped-text", { bin: fake("looped-text") });
  const outcome = await run(spec);
  assert.equal(outcome.status, "looped");
  assert.equal(outcome.error, "repeated bash 4 times with the same result");
  assert.deepEqual(outcome.loop, { tool: "bash", repeats: 4 });
  assert.equal(outcome.finalText, "done");
  assert.ok(!alive(Number(fs.readFileSync(spec.record, "utf8"))), "looped child survived");
}

// identical turns during the handoff do not trip the loop guard
{
  const spec = budgetSpec("loops", "loops");
  const outcome = await run(spec);
  const [first, second] = records(spec);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.loop, undefined);
  assert.equal(outcome.valve?.fired, true);
  assert.equal(outcome.valve?.ended, false);
  assert.equal(outcome.finalText, "bye");
  assert.equal(second.stdin, handoffPrompt("commit", { output: spec.item.output, tokens: 6000 }));
  gone(first);
  gone(second);
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
