import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";

const cliFile = fileURLToPath(new URL("./cli.mjs", import.meta.url));
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
async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-test-")));
const fakePi = path.join(tmp, "fake-pi.mjs");
const graphFile = path.join(tmp, "tiny-graph.mjs");
const fakeLog = path.join(tmp, "fake.log");
const configFile = path.join(tmp, "config.json");

fs.writeFileSync(
  fakePi,
  `import fs from "node:fs";
let brief = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) brief += chunk;
const output = /exactly this path: (.*)/.exec(brief)?.[1];
const marker = /SLEEPONCE (\\S+)/.exec(brief)?.[1];
const delay = Number(/DELAY (\\d+)/.exec(brief)?.[1] ?? 0);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, key: brief.split("\\n")[0] }) + "\\n");
const hang = /^SLEEP\\b/m.test(brief) || (marker && !fs.existsSync(marker));
if (marker) fs.writeFileSync(marker, "1");
if (hang) await new Promise((resolve) => setTimeout(resolve, 120000));
if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
if (output) fs.writeFileSync(output, "written by the fake pi");
const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35 };
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "done" }], usage, stopReason: "stop" },
}) + "\\n");
`,
);

fs.writeFileSync(
  graphFile,
  `import fs from "node:fs";
import path from "node:path";

export default async function tiny(args, port) {
  while (args.hold && !fs.existsSync(args.hold)) await new Promise((resolve) => setTimeout(resolve, 20));
  const node = (key, task) => ({
    key,
    agent: "worker",
    task: task + " " + args.dir,
    output: path.join(args.dir, key + ".md"),
    gate: { command: args.gateCommand ?? "echo " + key + " >> " + args.gateLog },
  });
  const board = (stage) => port.emit({ stage });
  if (args.kind === "gated") {
    const r = await port.runOne(node("a", "A"));
    return { kind: args.kind, a: r.status, gate: r.gate?.exit };
  }
  if (args.kind === "sleep") {
    board("sleeping");
    const r = await port.runOne(node("a", "SLEEP"));
    return { kind: args.kind, a: r.status };
  }
  if (args.kind === "batch") {
    board("batch");
    const [a, b] = await port.runMany([node("a", "A"), node("b", "B SLEEPONCE " + args.marker)]);
    board("batch done");
    return { kind: args.kind, a: a.status, b: b.status, replayed: [a.replayed === true, b.replayed === true] };
  }
  if (args.kind === "seq") {
    board("first");
    const a = await port.runOne(node("a", "A"));
    board("second");
    const b = await port.runOne(node("b", "B SLEEPONCE " + args.marker));
    return { kind: args.kind, a: a.status, b: b.status, replayed: [a.replayed === true, b.replayed === true] };
  }
  board("first");
  const a = await port.runOne(node("a", "A DELAY " + (args.delay ?? 0)));
  board("second");
  const b = await port.runOne(node("b", "B"));
  return { kind: args.kind, a: a.status, b: b.status, aOutput: a.outputExists, usage: a.usage };
}
`,
);

const role = { prompt: "/p.md", tools: ["read"], thinking: "low", acceptance: null };
fs.writeFileSync(
  configFile,
  JSON.stringify({
    model: "test/model",
    stateDir: path.join(tmp, "state"),
    worktreeDir: path.join(tmp, "worktrees"),
    concurrency: 2,
    roles: { worker: role, scout: role },
  }),
);

const env = {
  ...process.env,
  RECIPE_RUNNER_CONFIG: configFile,
  RECIPE_PI_BIN: JSON.stringify([process.execPath, fakePi]),
  FAKE_LOG: fakeLog,
};

function cli(args, { cwd = tmp } = {}) {
  const r = spawnSync(process.execPath, [cliFile, ...args], { env, cwd, encoding: "utf8", timeout: 120000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const json = (text) => JSON.parse(text.trim().split("\n").pop());
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const fakeStarts = (s, prefix) =>
  (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.key.startsWith(prefix + " ") && entry.key.endsWith(s.dir));
const gateRuns = (file, key) =>
  (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").split("\n").filter((line) => line === key).length;
const records = (dir) =>
  fs
    .readFileSync(path.join(dir, "runner", "children.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

let counter = 0;
function scenario(kind, extra = {}) {
  counter += 1;
  const dir = path.join(tmp, `task${counter}`);
  fs.mkdirSync(dir);
  const args = { kind, dir, gateLog: path.join(dir, "gates.log"), marker: path.join(dir, "marker"), ...extra };
  return { dir, args };
}
const runArgs = (command, { args }) => [command, "tiny", "--graph", graphFile, "--args", JSON.stringify(args), "--cwd", tmp];

const strays = new Set();
try {
  // Config defaults and overrides.
  {
    const config = loadConfig({ RECIPE_RUNNER_CONFIG: configFile });
    assert.equal(config.concurrency, 2);
    assert.equal(config.inFlightTokens, null);
    const missing = path.join(tmp, "nothing.json");
    assert.throws(() => loadConfig({ RECIPE_RUNNER_CONFIG: missing }), /cannot read the runner config/);
    const bare = path.join(tmp, "bare.json");
    fs.writeFileSync(bare, "{}");
    const defaults = loadConfig({ RECIPE_RUNNER_CONFIG: bare });
    assert.equal(defaults.worktreeDir, "/var/tmp/pi-worktrees");
    assert.equal(defaults.stateDir, "/var/tmp/recipe-runner");
    assert.equal(defaults.concurrency, 3);
  }

  // A foreground run writes status, board and receipt.
  {
    const s = scenario("two");
    const r = cli(runArgs("run", s));
    assert.equal(r.code, 0, r.stderr);
    const status = readJson(path.join(s.dir, "runner", "status.json"));
    assert.equal(status.state, "complete");
    assert.equal(status.recipe, "tiny");
    assert.equal(status.resumedAt, null);
    assert.deepEqual(status.board, { stage: "second" });
    const receipt = readJson(path.join(s.dir, "receipt.json"));
    assert.equal(receipt.a, "done");
    assert.equal(receipt.b, "done");
    assert.equal(receipt.aOutput, true);
    assert.equal(receipt.usage.prompt, 30);
    assert.equal(fs.readFileSync(path.join(s.dir, "a.md"), "utf8"), "written by the fake pi");
    assert.equal(gateRuns(s.args.gateLog, "a"), 1);
    assert.equal(records(s.dir).filter((rec) => rec.type === "settle").length, 2);
    assert.equal(cli(["wait", s.dir]).code, 0);
  }

  // start returns at once and the run outlives its starter; wait returns the receipt.
  {
    const s = scenario("two", { delay: 1500 });
    const began = Date.now();
    const started = cli(runArgs("start", s));
    assert.equal(started.code, 0, started.stderr);
    const info = json(started.stdout);
    assert.equal(info.taskDir, s.dir);
    assert.equal(info.status, "running");
    assert.ok(Date.now() - began < 1400, "start waited for the run");
    strays.add(info.pid);
    assert.ok(alive(info.pid), "the run did not survive its starter");
    const second = cli(runArgs("run", s));
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already going/);
    const waited = cli(["wait", s.dir]);
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(json(waited.stdout).a, "done");
    assert.equal(cli(["wait", s.dir, "--timeout-ms", "100"]).code, 0);
    assert.ok(fs.existsSync(path.join(s.dir, "runner", "runner.log")));

    // Starting again in the same directory sets the earlier runner/ aside.
    const again = cli(runArgs("start", s));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(cli(["wait", s.dir]).code, 0);
    const asides = fs.readdirSync(s.dir).filter((name) => /^runner\.\d/.test(name));
    assert.equal(asides.length, 1);
    assert.equal(readJson(path.join(s.dir, asides[0], "status.json")).state, "complete");
    assert.equal(readJson(path.join(s.dir, "runner", "status.json")).pid, json(again.stdout).pid);
    assert.equal(records(s.dir).filter((rec) => rec.type === "settle").length, 2, "the new run did not start from the old results");
  }

  // stop ends a run whose child sleeps, with no child left.
  {
    const s = scenario("sleep", { hold: path.join(tmp, "hold-sleep") });
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    assert.deepEqual(records(s.dir), [], "a started run has its children log before any child");
    fs.writeFileSync(s.args.hold, "");
    const sleeper = await until(() => records(s.dir).find((rec) => rec.type === "start")?.pid, "the child record");
    assert.ok(alive(sleeper));
    const stopped = cli(["stop", s.dir]);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(json(stopped.stdout).state, "stopped");
    assert.ok(!alive(sleeper), "the fake pi survived the stop");
    assert.ok(!alive(info.pid));
    const status = readJson(path.join(s.dir, "runner", "status.json"));
    assert.equal(status.state, "stopped");
    const stoppedReceipt = readJson(path.join(s.dir, "receipt.json"));
    assert.equal(stoppedReceipt.stopped, true);
    assert.match(stoppedReceipt.reason, /^SIGTERM/);
    assert.ok(!("failed" in stoppedReceipt), "a deliberate stop is not a failure");
    assert.deepEqual(stoppedReceipt.interrupted, records(s.dir).filter((rec) => rec.type === "start").map((rec) => rec.key));
    assert.ok(stoppedReceipt.interrupted.length > 0);
    assert.equal(gateRuns(s.args.gateLog, "a"), 0, "a killed child got a gate");
    assert.equal(records(s.dir).filter((rec) => rec.type === "settle").length, 0);
    assert.equal(cli(["wait", s.dir]).code, 1);
  }

  // Stop part way through a batch, then resume: the finished node is replayed,
  // the unfinished one runs again and its gate runs once.
  {
    const s = scenario("batch");
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    await until(() => records(s.dir).some((rec) => rec.type === "settle" && rec.key === "a"), "node a to settle");
    await until(() => fakeStarts(s, "B").length === 1, "node b to start");
    assert.equal(cli(["stop", s.dir]).code, 0);
    const stoppedStatus = readJson(path.join(s.dir, "runner", "status.json"));
    assert.equal(stoppedStatus.state, "stopped");
    assert.equal(gateRuns(s.args.gateLog, "a"), 1);
    assert.equal(gateRuns(s.args.gateLog, "b"), 0);

    const resumed = cli(["resume", s.dir]);
    assert.equal(resumed.code, 0, resumed.stderr);
    const receipt = readJson(path.join(s.dir, "receipt.json"));
    assert.deepEqual(receipt.replayed, [true, false]);
    assert.equal(receipt.b, "done");
    assert.equal(fakeStarts(s, "A").length, 1, "the finished node was started again");
    assert.equal(fakeStarts(s, "B").length, 2);
    assert.equal(gateRuns(s.args.gateLog, "a"), 1);
    assert.equal(gateRuns(s.args.gateLog, "b"), 1);
    const finalStatus = readJson(path.join(s.dir, "runner", "status.json"));
    assert.equal(finalStatus.state, "complete");
    assert.equal(finalStatus.startedAt, stoppedStatus.startedAt, "a resume overwrote when the run first started");
    assert.ok(new Date(finalStatus.resumedAt) > new Date(stoppedStatus.startedAt), "the resume recorded no resume time");
  }

  // SIGKILL of the run leaves its child; resume kills it before doing anything.
  {
    const s = scenario("seq");
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    const sleeper = await until(
      () => records(s.dir).find((rec) => rec.type === "start" && rec.key === "b")?.pid,
      "node b to start",
    );
    process.kill(info.pid, "SIGKILL");
    await until(() => !alive(info.pid), "the run to die");
    assert.ok(alive(sleeper), "the child should outlive a killed run");
    const resumed = cli(["resume", s.dir]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.ok(!alive(sleeper), "the first run's child survived the resume");
    assert.deepEqual(readJson(path.join(s.dir, "receipt.json")).replayed, [true, false]);
    assert.equal(fakeStarts(s, "A").length, 1);
    assert.equal(fakeStarts(s, "B").length, 2);
  }

  // stop on the directory of a dead run kills its child too; resume then replays what settled.
  {
    const s = scenario("seq");
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    const sleeper = await until(
      () => records(s.dir).find((rec) => rec.type === "start" && rec.key === "b")?.pid,
      "node b to start",
    );
    process.kill(info.pid, "SIGKILL");
    await until(() => !alive(info.pid), "the run to die");
    assert.equal(readJson(path.join(s.dir, "runner", "status.json")).state, "running");
    const stopped = cli(["stop", s.dir]);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.ok(!alive(sleeper), "stop left the dead run's child");
    assert.equal(readJson(path.join(s.dir, "runner", "status.json")).state, "stopped");
    const stoppedReceipt = readJson(path.join(s.dir, "receipt.json"));
    assert.equal(stoppedReceipt.stopped, true);
    assert.equal(stoppedReceipt.reason, "stop requested (process gone)");
    assert.ok(!("failed" in stoppedReceipt), "a deliberate stop is not a failure");
    assert.deepEqual(stoppedReceipt.interrupted, []);
    assert.equal(cli(["wait", s.dir]).code, 1);

    const before = fakeStarts(s, "A").length;
    const resumed = cli(["resume", s.dir, "--detach"]);
    assert.equal(resumed.code, 0, resumed.stderr);
    strays.add(json(resumed.stdout).pid);
    assert.equal(cli(["wait", s.dir]).code, 0);
    assert.equal(fakeStarts(s, "A").length, before, "the settled node was started again");
    assert.deepEqual(readJson(path.join(s.dir, "receipt.json")).replayed, [true, false]);
  }

  // wait on a run whose process died and that wrote no receipt reports a stopped receipt.
  {
    const s = scenario("seq");
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    await until(() => records(s.dir).find((rec) => rec.type === "start" && rec.key === "a")?.pid, "node a to start");
    process.kill(info.pid, "SIGKILL");
    await until(() => !alive(info.pid), "the run to die");
    assert.ok(!fs.existsSync(path.join(s.dir, "receipt.json")));
    const waited = cli(["wait", s.dir]);
    assert.equal(waited.code, 1, waited.stderr);
    const lastBoard = readJson(path.join(s.dir, "runner", "status.json")).board;
    assert.deepEqual(json(waited.stdout), { stopped: true, reason: "process gone", interrupted: [], board: lastBoard });
  }

  // SIGKILL of the run during a long gate leaves the gate; resume kills it and runs the gate once.
  {
    const s = scenario("gated");
    const pids = path.join(s.dir, "gate-pids");
    s.args.gateCommand = `echo $$ >> ${pids}; if [ ! -e ${s.args.marker} ]; then touch ${s.args.marker}; sleep 120; fi; echo a >> ${s.args.gateLog}`;
    const info = json(cli(runArgs("start", s)).stdout);
    strays.add(info.pid);
    const gatePid = await until(() => records(s.dir).find((rec) => rec.type === "gate-start")?.pid, "the gate to start");
    process.kill(info.pid, "SIGKILL");
    await until(() => !alive(info.pid), "the run to die");
    assert.ok(alive(gatePid), "the gate should outlive a killed run");
    const resumed = cli(["resume", s.dir]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.ok(!alive(gatePid), "the first run's gate survived the resume");
    assert.equal(gateRuns(s.args.gateLog, "a"), 1);
    assert.equal(fs.readFileSync(pids, "utf8").trim().split("\n").length, 2);
    const gateRecords = records(s.dir).filter((rec) => rec.type.startsWith("gate"));
    assert.deepEqual(gateRecords.map((rec) => rec.type), ["gate-start", "gate-end", "gate-start", "gate-end"]);
  }

  // dispatch: one child through the same port.
  {
    const dir = path.join(tmp, "dispatch");
    const resultFile = path.join(tmp, "result.json");
    const r = cli([
      "dispatch",
      "--role",
      "scout",
      "--brief",
      "x",
      "--gate",
      String.raw`echo {\"ok\":true}`,
      "--gate-json",
      "--dir",
      dir,
      "--result-file",
      resultFile,
    ]);
    assert.equal(r.code, 0, r.stderr);
    const result = json(r.stdout);
    assert.equal(result.status, "done");
    assert.equal(result.structuredOutput?.ok, true, JSON.stringify(result));
    assert.deepEqual(readJson(resultFile).structuredOutput, { ok: true });
    assert.ok(fs.existsSync(path.join(dir, "children.jsonl")));

    const unknown = json(cli(["dispatch", "--role", "nobody", "--brief", "x"]).stdout);
    assert.equal(unknown.status, "skipped");
  }

  // dispatch with a worktree: removed when untouched, kept on request.
  {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const removed = json(cli(["dispatch", "--role", "scout", "--brief", "x", "--worktree", "--cwd", repo]).stdout);
    assert.equal(removed.status, "done");
    assert.equal(removed.worktree, null);
    const kept = json(cli(["dispatch", "--role", "scout", "--brief", "x", "--worktree", "--keep-worktree", "--cwd", repo]).stdout);
    assert.ok(kept.worktree && fs.existsSync(kept.worktree));
    assert.match(kept.branch, /^recipe\//);
  }

  // Usage errors exit 2.
  assert.equal(cli(["nonsense"]).code, 2);
  assert.equal(cli(["run", "tiny"]).code, 2);
} finally {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  for (const entry of fs.readdirSync(tmp)) {
    if (!entry.startsWith("task")) continue;
    const file = path.join(tmp, entry, "runner", "children.jsonl");
    if (!fs.existsSync(file)) continue;
    const recs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const ended = new Set(recs.filter((rec) => rec.type === "end").map((rec) => rec.runId));
    for (const rec of recs) {
      if (rec.type === "start" && rec.pid && !ended.has(rec.runId)) {
        try {
          process.kill(rec.pid, "SIGKILL");
        } catch {
          continue;
        }
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("ok");
