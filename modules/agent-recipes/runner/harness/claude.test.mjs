import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handoffPrompt } from "../handoff.mjs";
import { claudeArgv, claudeSessionFile, claudeSessionId, start, usesEngine } from "./claude.mjs";

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
import path from "node:path";
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv, stdin, cwd: process.cwd(), pid: process.pid,
  env: { RECIPE_CHILD: process.env.RECIPE_CHILD, EXTRA: process.env.EXTRA,
    SESSION: process.env.CLAUDE_CODE_SESSION_ID, PID: process.env.CLAUDE_PID,
    SOCKET: process.env.CLAUDE_CODE_MESSAGING_SOCKET, TOKEN: process.env.CLAUDE_CODE_MESSAGING_TOKEN },
}));
const session_id = argv[argv.indexOf("--session-id") + 1] ?? argv[argv.indexOf("--resume") + 1];
if (process.env.CLAUDE_CONFIG_DIR) {
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  fs.appendFileSync(path.join(folder, session_id + ".jsonl"), "{}\\n");
}
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

// A first run that reads, writes and then calls a tool far over the budget,
// and would otherwise sleep for a minute; a resumed run that answers at once.
// FAKE_MODE picks the shape: `text` makes the big message a plain answer,
// `nowrite` drops the Write, `commit` swaps it for a git commit, `hang2` keeps
// the resumed run alive.
fs.writeFileSync(
  path.join(fakes, "budget.mjs"),
  `import { spawn } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
const resumed = argv.includes("--resume");
const mode = process.env.FAKE_MODE ?? "";
const lingers = resumed ? mode === "hang2" : mode !== "text";
const grandchild = lingers ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }) : null;
fs.writeFileSync(process.env.FAKE_RECORD + (resumed ? ".2" : ".1"), JSON.stringify({ argv, stdin, pid: process.pid, grandchild: grandchild?.pid ?? null }));
const session_id = argv[argv.indexOf("--session-id") + 1] ?? argv[argv.indexOf("--resume") + 1];
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const message = (id, block, usage) => line({
  type: "assistant", session_id,
  message: { id, role: "assistant", content: [block], usage: { cache_creation_input_tokens: 0, ...usage } },
});
const result = (text) => line({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", session_id });
if (resumed) {
  message("msg_h", { type: "text", text: "handoff: x" }, { input_tokens: 5, cache_read_input_tokens: 6000, output_tokens: 50 });
  if (mode === "hang2") await new Promise(() => {});
  result("handoff: x");
  process.exit(0);
}
message("msg_a", { type: "tool_use", id: "t1", name: "Read", input: {} }, { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 90 });
if (mode === "commit") {
  message("msg_b", { type: "tool_use", id: "t2", name: "Bash", input: { command: "cd x && git commit -m y" } }, { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 1900, output_tokens: 95 });
} else if (mode !== "nowrite" && mode !== "text") {
  message("msg_b", { type: "tool_use", id: "t2", name: "Write", input: { file_path: "n.md" } }, { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 1900, output_tokens: 95 });
}
const big = { input_tokens: 5, cache_read_input_tokens: 5800, output_tokens: 195 };
if (mode === "text") {
  message("msg_c", { type: "text", text: "all finished" }, big);
  result("all finished");
  process.exit(0);
}
message("msg_c", { type: "thinking", thinking: "hm" }, big);
message("msg_c", { type: "tool_use", id: "t3", name: "Bash", input: { command: "ls" } }, big);
await new Promise(() => {});
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
  const config = path.join(tmp, "ok-config");
  const spec = specFor("ok", { env: { EXTRA: "yes", CLAUDE_CONFIG_DIR: config } });
  const spawned = [];
  Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_PID: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/x.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" });
  const outcome = await run({ ...spec, onSpawn: (info) => spawned.push(info) });
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"]) delete process.env[name];
  const record = JSON.parse(fs.readFileSync(spec.record, "utf8"));

  assert.equal(outcome.status, "done");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stopReason, "end_turn");
  assert.equal(outcome.finalText, "All done twice");
  // msg_1 arrives on two lines with the same usage and counts once
  assert.deepEqual(outcome.usage, {
    prompt: 3105, cached: 2100, output: 70, peakContext: 1632, turns: 2, compactions: 1, firstContext: 1632,
  });
  assert.equal(outcome.valve, null);
  const sessionFile = path.join(config, "projects", fs.realpathSync(tmp).replace(/[^a-zA-Z0-9]/g, "-"), `${claudeSessionId("r1-ok")}.jsonl`);
  assert.equal(outcome.sessionFile, sessionFile);
  assert.ok(fs.existsSync(sessionFile));
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
  assert.equal(again.sessionFile, sessionFile);
}

// the session file is null when claude wrote none, and found under another project directory name
{
  const config = path.join(tmp, "lookup-config");
  const spec = { cwd: tmp, runId: "lookup", sessionId: "lookup", env: { CLAUDE_CONFIG_DIR: config } };
  assert.equal(claudeSessionFile(spec), null);
  const other = path.join(config, "projects", "-elsewhere");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${claudeSessionId("lookup")}.jsonl`), "");
  assert.equal(claudeSessionFile(spec), path.join(other, `${claudeSessionId("lookup")}.jsonl`));
}

// each process a child ran is recorded with its argv and RECIPE_* variables, never the brief
{
  const spec = specFor("spawnlog", { env: { RECIPE_ROLE: "scout", EXTRA: "yes" } });
  await run(spec);
  const lines = fs.readFileSync(path.join(spec.logDir, "spawn.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].argv.slice(1), claudeArgv(spec));
  assert.equal(lines[0].env.RECIPE_ROLE, "scout");
  assert.equal(lines[0].env.RECIPE_CHILD, "1");
  assert.ok(Object.keys(lines[0].env).every((name) => name.startsWith("RECIPE_")));
  assert.ok(!JSON.stringify(lines[0]).includes(spec.brief));
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

// the budget: the first over-budget tool call kills the child, and one narrowed turn on the same session follows
{
  const budgetSpec = (label, mode, overrides = {}) => {
    const spec = specFor(label, {
      bin: fake("budget"),
      budget: { tokens: 5000, reserve: 10000, action: "commit" },
      item: { output: path.join(tmp, label, "notes", "note.md") },
      ...overrides,
    });
    return { ...spec, env: { ...spec.env, FAKE_MODE: mode } };
  };
  const records = (spec) => [1, 2].map((n) => {
    const file = `${spec.record}.${n}`;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  });
  const gone = (record) => assert.ok(!alive(record.pid) && !(record.grandchild && alive(record.grandchild)), "a process survived");

  {
    const spec = budgetSpec("budget-commit", "");
    const spawned = [];
    const started = Date.now();
    const outcome = await run({ ...spec, onSpawn: (info) => spawned.push(info.pid) });
    const [first, second] = records(spec);
    const session = claudeSessionId("r1-budget-commit");

    assert.ok(Date.now() - started < 15000, "the first process was not killed");
    assert.equal(outcome.status, "done");
    assert.equal(outcome.finalText, "handoff: x");
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.valve, { fired: true, tokens: 6000, budget: 5000, action: "commit", ended: false });
    assert.deepEqual(outcome.usage, {
      prompt: 15125, cached: 14600, output: 430, peakContext: 6055, turns: 4, compactions: 0, firstContext: 2500,
    });
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned, [first.pid, second.pid]);
    assert.notEqual(spawned[0], spawned[1]);
    gone(first);
    gone(second);

    assert.deepEqual(first.argv.slice(-2), ["--session-id", session]);
    assert.equal(first.stdin, "Do the thing.");
    assert.deepEqual(second.argv.slice(-2), ["--resume", session]);
    assert.ok(!second.argv.includes("--session-id"));
    assert.equal(second.argv[second.argv.indexOf("--tools") + 1], "Write,Edit,Bash");
    const allowed = second.argv.slice(second.argv.indexOf("--allowedTools") + 1, second.argv.indexOf("--permission-prompts"));
    assert.deepEqual(allowed, [`Write(/${spec.item.output})`, `Edit(/${spec.item.output})`, "Bash(git *)"]);
    assert.ok(spec.item.output.startsWith("/") && allowed[0].startsWith("Write(//"));
    assert.equal(second.stdin, handoffPrompt("commit", { output: spec.item.output, tokens: 6000 }));
    assert.deepEqual(second.argv.slice(0, 4), first.argv.slice(0, 4));
    assert.equal(second.argv[second.argv.indexOf("--model") + 1], "sonnet");

    const logged = fs.readFileSync(path.join(spec.logDir, "events.jsonl"), "utf8");
    assert.match(logged, /msg_h/);
    assert.match(logged, /msg_c/);
  }

  // an action other than commit gets no Bash; a relative output resolves against the working directory
  {
    const spec = budgetSpec("budget-stop", "", {
      budget: { tokens: 5000, reserve: 10000, action: "stop" },
      item: { output: "notes/note.md" },
    });
    const outcome = await run(spec);
    const second = records(spec)[1];
    const absolute = path.resolve(tmp, "notes/note.md");
    assert.equal(outcome.valve.action, "stop");
    assert.equal(second.argv[second.argv.indexOf("--tools") + 1], "Write,Edit");
    const allowed = second.argv.slice(second.argv.indexOf("--allowedTools") + 1, second.argv.indexOf("--permission-prompts"));
    assert.deepEqual(allowed, [`Write(/${absolute})`, `Edit(/${absolute})`]);
    gone(records(spec)[0]);
    gone(second);
  }

  // with no output file the reply is the note, so only a commit may touch anything
  {
    const spec = budgetSpec("budget-reply", "", { item: {} });
    await run(spec);
    const second = records(spec)[1];
    assert.equal(second.argv[second.argv.indexOf("--tools") + 1], "Bash");
    assert.deepEqual(
      second.argv.slice(second.argv.indexOf("--allowedTools") + 1, second.argv.indexOf("--permission-prompts")),
      ["Bash(git *)"],
    );
    const bare = budgetSpec("budget-reply2", "", { item: {}, budget: { tokens: 5000, reserve: 1, action: "stop" } });
    await run(bare);
    const none = records(bare)[1];
    assert.equal(none.argv[none.argv.indexOf("--tools") + 1], "");
    assert.ok(!none.argv.includes("--allowedTools"));
  }

  // the context at the first commit stands in when nothing was written with a tool
  {
    const spec = budgetSpec("budget-git", "commit");
    const outcome = await run(spec);
    assert.equal(outcome.usage.firstContext, 2500);
    assert.equal(outcome.valve.fired, true);
  }

  // with nothing written or committed, the first context is the peak
  {
    const spec = budgetSpec("budget-nowrite", "nowrite");
    const outcome = await run(spec);
    assert.equal(outcome.valve.fired, true);
    assert.equal(outcome.usage.peakContext, 6055);
    assert.equal(outcome.usage.firstContext, 6055);
  }

  // a final answer over the budget is let finish
  {
    const spec = budgetSpec("budget-text", "text");
    const outcome = await run(spec);
    const [first, second] = records(spec);
    assert.equal(outcome.status, "done");
    assert.equal(outcome.finalText, "all finished");
    assert.equal(outcome.valve, null);
    assert.equal(second, null);
    assert.equal(outcome.usage.peakContext, 6000);
    assert.equal(outcome.usage.firstContext, 6000);
    gone(first);
  }

  // no budget never triggers; neither does a zero one
  for (const [label, budget] of [["budget-null", null], ["budget-zero", { tokens: 0, reserve: 0, action: "stop" }]]) {
    const spec = budgetSpec(label, "", { budget, timeoutMs: 1500 });
    const outcome = await run(spec);
    const [first, second] = records(spec);
    assert.equal(outcome.status, "timeout");
    assert.equal(outcome.valve, null);
    assert.equal(second, null);
    gone(first);
  }

  // an abort during the handoff turn still ends as aborted, and kills it
  {
    const controller = new AbortController();
    const spec = budgetSpec("budget-abort", "hang2", { signal: controller.signal });
    let spawns = 0;
    const outcome = await run({
      ...spec,
      onSpawn: () => {
        if (++spawns === 2) setTimeout(() => controller.abort(), 300);
      },
    });
    const [first, second] = records(spec);
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.valve.fired, true);
    gone(first);
    gone(second);
  }
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
