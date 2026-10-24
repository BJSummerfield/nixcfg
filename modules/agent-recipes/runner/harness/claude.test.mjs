import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeArgv, claudeSessionId, start, usesEngine } from "./claude.mjs";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-claude-"));
const fakes = path.join(tmp, "fakes");
fs.mkdirSync(fakes);

// The canned lines follow what `claude -p --output-format stream-json
// --verbose` printed: session state and init lines, one assistant line per
// content block (repeating the message id and usage), user lines carrying
// tool results, a rate-limit line and a closing result line.
fs.writeFileSync(
  path.join(fakes, "ok.mjs"),
  `import fs from "node:fs";
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv, stdin, cwd: process.cwd(), pid: process.pid,
  env: { RECIPE_CHILD: process.env.RECIPE_CHILD, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, EXTRA: process.env.EXTRA },
}));
const session_id = argv[argv.indexOf("--session-id") + 1] ?? argv[argv.indexOf("--resume") + 1];
const usage = (fields) => ({
  input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: "standard", ...fields,
});
const assistant = (id, content, fields) => ({
  type: "assistant",
  message: { model: "claude-sonnet-5-5", id, type: "message", role: "assistant", content, stop_reason: null, usage: usage(fields) },
  parent_tool_use_id: null, session_id, uuid: "u-" + Math.random(),
});
const lines = [
  { type: "system", subtype: "session_state_changed", state: "running", session_id },
  { type: "system", subtype: "init", cwd: process.cwd(), session_id, tools: ["Read", "Write"], model: "claude-sonnet-5-5", permissionMode: "default" },
  assistant("msg_1", [{ type: "thinking", thinking: "hm" }], { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 10 }),
  assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }], { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 40 }),
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] }, session_id },
  { type: "system", subtype: "compact_boundary", session_id },
  assistant("msg_2", [{ type: "text", text: "All" }, { type: "text", text: "done" }], { input_tokens: 2, cache_read_input_tokens: 1600, output_tokens: 30 }),
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id },
  {
    type: "result", subtype: "success", is_error: false, num_turns: 2, result: "All done\\u2028twice", stop_reason: "end_turn",
    terminal_reason: "completed", session_id, total_cost_usd: 0.01,
    usage: usage({ input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2100, output_tokens: 70 }),
  },
  { type: "system", subtype: "session_state_changed", state: "idle", session_id },
];
process.stdout.write("not json at all\\r\\n");
for (const [index, line] of lines.entries()) {
  const text = JSON.stringify(line) + "\\n";
  if (index === 6) {
    const middle = Math.floor(text.length / 2);
    process.stdout.write(text.slice(0, middle));
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.stdout.write(text.slice(middle));
  } else {
    process.stdout.write(text);
  }
}
process.stderr.write("warning from claude\\n");
`,
);

fs.writeFileSync(
  path.join(fakes, "hang.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_RECORD, String(grandchild.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }) + "\\n");
setTimeout(() => {}, 60000);
`,
);

fs.writeFileSync(
  path.join(fakes, "boom.mjs"),
  `process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1 } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", stop_reason: null, terminal_reason: "model_error" }) + "\\n");
process.exit(1);
`,
);

fs.writeFileSync(
  path.join(fakes, "turns.mjs"),
  `process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false, num_turns: 3, stop_reason: "tool_use", errors: ["too many turns"] }) + "\\n");
`,
);

fs.writeFileSync(
  path.join(fakes, "silent.mjs"),
  `process.stderr.write("not logged in\\n");
process.exit(1);
`,
);

fs.writeFileSync(
  path.join(fakes, "noresult.mjs"),
  `process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }) + "\\n");
`,
);

const fake = (name) => [process.execPath, path.join(fakes, `${name}.mjs`)];

function specFor(label, overrides = {}) {
  const base = path.join(tmp, label);
  return {
    runId: `r1-${label}`,
    roleName: "scout",
    role: {
      prompt: "/ignored/by/claude.md",
      thinking: "medium",
      tools: ["read"],
      claude: { agent: "scout", model: "sonnet", tools: "Read, Grep, Glob, Bash, Write" },
    },
    model: "redtruck/qwen",
    extensions: ["/ext/a.js"],
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

assert.equal(usesEngine, false);

// session ids
{
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(claudeSessionId("r20261024120000-abc123-draft"), uuid);
  assert.equal(claudeSessionId("r20261024120000-abc123-draft"), claudeSessionId("r20261024120000-abc123-draft"));
  assert.notEqual(claudeSessionId("a"), claudeSessionId("b"));
  assert.equal(claudeSessionId("7A1F2C3E-1111-4222-8333-444455556666"), "7a1f2c3e-1111-4222-8333-444455556666");
}

// argv forms
{
  const spec = specFor("argv");
  const session = claudeSessionId("r1-argv");
  assert.deepEqual(claudeArgv(spec), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--agent", "scout",
    "--model", "sonnet",
    "--effort", "medium",
    "--tools", "Read,Grep,Glob,Bash,Write",
    "--allowedTools", "Read,Grep,Glob,Bash,Write",
    "--permission-prompts", "none",
    "--session-id", session,
  ]);
  const resumed = claudeArgv({ ...spec, runId: "r2-argv", resume: true });
  assert.deepEqual(resumed.slice(-2), ["--resume", session]);
  assert.ok(!resumed.includes("--session-id"));
  assert.ok(!claudeArgv(spec).includes(spec.brief));
  for (const [thinking, effort] of [["off", "low"], ["minimal", "low"], ["low", "low"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]]) {
    const argv = claudeArgv({ ...spec, role: { ...spec.role, thinking } });
    assert.equal(argv[argv.indexOf("--effort") + 1], effort);
  }
  const bare = claudeArgv({ ...spec, role: { claude: {} } });
  assert.deepEqual(bare.slice(4, 6), ["--agent", "scout"]);
  assert.ok(!bare.some((a) => ["--model", "--effort", "--tools", "--allowedTools"].includes(a)));
  const listed = claudeArgv({ ...spec, role: { claude: { tools: ["Read", "Write"] } } });
  assert.equal(listed[listed.indexOf("--tools") + 1], "Read,Write");
}

// a normal run, then a resumed one on the same session
{
  const spec = specFor("ok");
  const spawned = [];
  const outcome = await run({ ...spec, onSpawn: (info) => spawned.push(info) });
  const record = JSON.parse(fs.readFileSync(spec.record, "utf8"));

  assert.equal(outcome.status, "done");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stopReason, "end_turn");
  assert.equal(outcome.finalText, "All done twice");
  // msg_1 arrives on two lines with the same usage and counts once
  assert.deepEqual(outcome.usage, { prompt: 3105, cached: 2100, output: 70, peakContext: 1632, turns: 2, compactions: 1 });
  assert.equal(outcome.sessionFile, null);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].pid, record.pid);
  assert.deepEqual(record.argv, claudeArgv(spec));
  assert.equal(record.stdin, "Do the thing.");
  assert.equal(record.cwd, fs.realpathSync(tmp));
  assert.deepEqual(record.env, { RECIPE_CHILD: "1", EXTRA: "yes" });

  const events = fs.readFileSync(path.join(spec.logDir, "events.jsonl"), "utf8").split("\n");
  assert.equal(events.pop(), "");
  assert.equal(events[0], "not json at all");
  assert.equal(events.length, 11);
  assert.equal(fs.readFileSync(path.join(spec.logDir, "stderr.log"), "utf8"), "warning from claude\n");
  assert.ok(!fs.existsSync(spec.transcriptFile));

  const resumedSpec = {
    ...spec,
    runId: "r2-ok",
    resume: true,
    logDir: path.join(tmp, "ok", "log2"),
    record: path.join(tmp, "ok", "record2.json"),
  };
  const again = await run(resumedSpec);
  const resumedRecord = JSON.parse(fs.readFileSync(resumedSpec.record, "utf8"));
  assert.equal(again.status, "done");
  assert.deepEqual(resumedRecord.argv.slice(-2), ["--resume", claudeSessionId("r1-ok")]);
  assert.equal(resumedRecord.stdin, "Do the thing.");
  assert.ok(!resumedRecord.argv.includes("--session-id"));
  assert.equal(again.sessionFile, null);
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
  assert.match(outcome.error, /timed out after 500ms/);
  assert.ok(Date.now() - startedAt < 15000);
  assert.ok(grandchild > 0);
  assert.ok(!alive(grandchild), "grandchild survived the timeout");
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
  assert.equal(boom.error, "boom");
  assert.equal(boom.usage.turns, 1);
  assert.equal(boom.usage.prompt, 5);

  const turns = await run(specFor("turns", { bin: fake("turns") }));
  assert.equal(turns.status, "failed");
  assert.equal(turns.exitCode, 0);
  assert.equal(turns.error, "too many turns");

  const silent = await run(specFor("silent", { bin: fake("silent") }));
  assert.equal(silent.status, "failed");
  assert.equal(silent.error, "not logged in");

  const none = await run(specFor("noresult", { bin: fake("noresult") }));
  assert.equal(none.status, "failed");
  assert.equal(none.error, "no result line");

  const missing = await run(specFor("missing", { bin: [path.join(tmp, "no-such-claude")] }));
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /ENOENT/);
}

// the binary can come from RECIPE_CLAUDE_BIN
{
  process.env.RECIPE_CLAUDE_BIN = JSON.stringify(fake("ok"));
  const spec = specFor("envbin", { bin: undefined });
  const outcome = await run(spec);
  delete process.env.RECIPE_CLAUDE_BIN;
  assert.equal(outcome.status, "done");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok");
