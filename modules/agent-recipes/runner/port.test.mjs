import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fakeDeps, portOf, runThroughRunner } from "./fake.mjs";
import { procStartTime } from "./limits.mjs";
import { createPort, fingerprint, killUnfinished } from "./port.mjs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-port-"));
let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = { prompt: 1, cached: 0, output: 1, peakContext: 1, turns: 1, compactions: 0 };
const readLog = (runDir) =>
  fs
    .readFileSync(path.join(runDir, "children.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const roles = {
  writer: { prompt: "p", tools: [], thinking: "low", acceptance: "writer" },
  reader: { prompt: "p", tools: [], thinking: "low", acceptance: null },
};

// A scripted harness: `script(spec)` returns the outcome fields to merge.
function fakeHarness(script, extra = {}) {
  const calls = [];
  let flying = 0;
  let peak = 0;
  return {
    calls,
    peak: () => peak,
    ...extra,
    async start(spec) {
      calls.push(spec);
      flying += 1;
      peak = Math.max(peak, flying);
      try {
        spec.onSpawn?.({ pid: null });
        const fields = (await script(spec)) ?? {};
        return {
          status: "done",
          exitCode: 0,
          signal: null,
          stopReason: "stop",
          finalText: "ok",
          usage,
          sessionFile: null,
          ms: 1,
          ...fields,
        };
      } finally {
        flying -= 1;
      }
    },
  };
}

function setup(name, { harness, config = {}, ...rest } = {}) {
  const dir = path.join(tmp, `${name}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const runDir = path.join(dir, "runner");
  const stateDir = path.join(dir, "state");
  const gates = [];
  const deps = {
    runGate: async (gate, ctx) => {
      gates.push({ gate, ...ctx, outputText: ctx.item.output && fs.existsSync(ctx.item.output) ? fs.readFileSync(ctx.item.output, "utf8") : null });
      return { ran: true, exit: 0, timedOut: false, ms: 1, tail: "", value: { ok: true }, problem: undefined };
    },
    worktrees: {
      make: ({ item }) => ({ ok: true, worktree: path.join(dir, "wt", item.key), branch: `recipe/${item.key}`, head: "HEAD" }),
      state: () => ({ exists: true, clean: true, commits: 0 }),
      remove: () => ({ ok: true }),
    },
    ...(rest.deps ?? {}),
  };
  const make = (extraOpts = {}) =>
    createPort({
      runDir,
      cwd: dir,
      config: { stateDir, roles, ...config },
      harnessName: "fake",
      harness,
      ...rest,
      ...extraOpts,
      deps: { ...deps, ...(extraOpts.deps ?? {}) },
    });
  return { dir, runDir, stateDir, gates, deps, port: make(), make };
}

const item = (key, extra = {}) => ({ key, agent: "writer", task: `do ${key}`, ...extra });

// Results keep order, concurrency 2 never has 3 in flight.
{
  const harness = fakeHarness(async (spec) => {
    await sleep(spec.item.key === "a" ? 60 : 10);
    return { finalText: `reply ${spec.item.key}` };
  });
  const { port } = setup("order", { harness, concurrency: 2 });
  const results = await port.runMany(["a", "b", "c", "d", "e"].map((k) => item(k)));
  assert.deepEqual(results.map((r) => r.runId.endsWith(`-${["a", "b", "c", "d", "e"][results.indexOf(r)]}`)), [true, true, true, true, true]);
  assert.deepEqual(harness.calls.map((c) => c.item.key).sort(), ["a", "b", "c", "d", "e"]);
  assert.ok(results.every((r) => r.ok && r.status === "done"));
  assert.equal(harness.peak(), 2);
  const [first] = results;
  assert.equal(first.finalText, "reply a");
  assert.deepEqual(first.usage, usage);
}

// The brief carries the output trailer; the spec names the transcript and log dir.
{
  const harness = fakeHarness(() => ({}));
  const { port, runDir, dir } = setup("brief", { harness });
  await port.runOne(item("brief", { output: path.join(dir, "out.md") }));
  const spec = harness.calls[0];
  assert.match(spec.brief, /^do brief\n\n---\n\*\*Output:\*\*\nWrite your findings to exactly this path: .*out\.md\nThis path is authoritative/);
  assert.match(spec.transcriptFile, new RegExp(`${runDir}/transcripts/[0-9a-f-]{36}_writer_transcript\\.jsonl$`));
  assert.equal(spec.logDir, path.join(runDir, "children", spec.runId));
  assert.equal(spec.sessionDir, path.join(runDir, "sessions"));
  assert.equal(spec.sessionId, spec.runId);
  assert.equal(spec.resume, false);
  assert.equal(spec.timeoutMs, 1200000);
}

// A big item takes the lock unless the harness does not use the engine.
{
  const locked = [];
  const bigLock = async (file) => {
    locked.push(file);
    return () => locked.push("released");
  };
  const harness = fakeHarness(() => ({}));
  const { port, stateDir } = setup("big", { harness, deps: { bigLock } });
  await port.runOne(item("big", { big: true }));
  await port.runOne(item("small"));
  assert.deepEqual(locked, [path.join(stateDir, "big.lock"), "released"]);

  const claude = fakeHarness(() => ({}), { usesEngine: false });
  const other = setup("nobig", { harness: claude, deps: { bigLock } });
  locked.length = 0;
  await other.port.runOne(item("big", { big: true }));
  assert.deepEqual(locked, []);
}

// Token reservations are taken only when the config has a budget.
{
  const reserved = [];
  const reserveTokens = async (dir, o) => {
    reserved.push({ dir, ...o });
    return () => {};
  };
  const harness = fakeHarness(() => ({}));
  const none = setup("noreserve", { harness, deps: { reserveTokens } });
  await none.port.runOne(item("a"));
  assert.equal(reserved.length, 0);
  const some = setup("reserve", { harness, config: { inFlightTokens: 500000, sizing: path.join(tmp, "missing.json") }, deps: { reserveTokens } });
  await some.port.runOne(item("a"));
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].budget, 500000);
  assert.equal(reserved[0].tokens, 100000);
  assert.equal(reserved[0].dir, path.join(some.stateDir, "inflight"));
}

// A writer that reports blocked or failed stops itself; a reader does not.
{
  const reply = { w1: "blocked: no access", w2: "  FAILED: compaction thrash\nmore", w3: "Done. blocked: not at the start" };
  const harness = fakeHarness((spec) => ({ finalText: reply[spec.item.key] ?? "blocked: reader" }));
  const { port } = setup("writer", { harness });
  const [w1, w2, w3, r1] = await port.runMany([item("w1"), item("w2"), item("w3"), item("r1", { agent: "reader" })]);
  assert.equal(w1.status, "stopped");
  assert.equal(w1.ok, false);
  assert.equal(w1.error, "reported as not-satisfied: blocked: no access");
  assert.equal(w2.status, "stopped");
  assert.equal(w2.error, "reported as not-satisfied: FAILED: compaction thrash");
  assert.equal(w3.status, "done");
  assert.equal(r1.status, "done");
}

// The harness's valve record reaches the result and the settle record; a child whose valve did not fire has none.
{
  const valve = { fired: true, tokens: 15568, budget: 12000, action: "commit", ended: true };
  const harness = fakeHarness((spec) => (spec.item.key === "tripped" ? { valve } : {}));
  const { port, runDir } = setup("valve", { harness });
  const tripped = await port.runOne(item("tripped"));
  assert.deepEqual(tripped.valve, valve);
  const quiet = await port.runOne(item("quiet"));
  assert.equal(quiet.valve, null);
  const settled = readLog(runDir).filter((r) => r.type === "settle");
  assert.deepEqual(settled.map((r) => r.result.valve), [valve, null]);
}

// A gate learns where the runner puts worktrees, so it can record the ones that are the run's.
{
  const { port, gates } = setup("gate-env", { harness: fakeHarness(() => ({})), config: { worktreeDir: "/some/where" } });
  await port.runOne(item("g", { gate: { command: "check" } }));
  assert.equal(gates[0].env.RECIPE_WORKTREE_ROOT, "/some/where");
  assert.equal(gates[0].env.PATH, process.env.PATH);
}

// A failed child still gets its gate, and so does a resumed one.
{
  const harness = fakeHarness((spec) => (spec.item.key === "bad" ? { status: "failed", error: "boom", finalText: "" } : {}));
  const { port, gates } = setup("gates", { harness });
  const gate = { command: "check", output: "json" };
  const first = await port.runOne(item("fresh", { gate }));
  assert.deepEqual(first.structuredOutput, { ok: true });
  assert.equal(first.gate.ran, true);
  const bad = await port.runOne(item("bad", { gate }));
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "boom");
  assert.equal(bad.gate.ran, true);
  const fix = await port.runOne(item("fix", { agent: undefined, resume: first.runId, gate }));
  assert.equal(fix.status, "done");
  assert.equal(fix.cwd, first.cwd);
  assert.equal(gates.length, 3);
  assert.equal(harness.calls[2].resume, true);
  assert.equal(harness.calls[2].roleName, "writer");
  const none = await port.runOne(item("nogate"));
  assert.equal(none.gate, null);
  assert.equal(none.structuredOutput, undefined);
}

// The output file falls back to the final reply before the gate reads it.
{
  const dir = path.join(tmp, "outputs");
  fs.mkdirSync(dir);
  const missing = path.join(dir, "missing.md");
  const unchanged = path.join(dir, "unchanged.md");
  const written = path.join(dir, "written.md");
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(unchanged, "old");
  const harness = fakeHarness(async (spec) => {
    if (spec.item.output === written) {
      await sleep(10);
      fs.writeFileSync(written, "from the child");
    }
    return { finalText: spec.item.output === empty ? "" : `reply for ${path.basename(spec.item.output)}` };
  });
  const { port, gates } = setup("fallback", { harness });
  const gate = { command: "check" };
  const results = await port.runMany([missing, unchanged, written, empty].map((output, i) => item(`o${i}`, { output, gate })));
  assert.equal(fs.readFileSync(missing, "utf8"), "reply for missing.md");
  assert.equal(fs.readFileSync(unchanged, "utf8"), "reply for unchanged.md");
  assert.equal(fs.readFileSync(written, "utf8"), "from the child");
  assert.equal(fs.existsSync(empty), false);
  assert.deepEqual(results.map((r) => r.outputExists), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.outputFromReply), [true, true, false, false]);
  const seen = Object.fromEntries(gates.map((g) => [path.basename(g.item.output), g.outputText]));
  assert.equal(seen["missing.md"], "reply for missing.md");
  assert.equal(seen["unchanged.md"], "reply for unchanged.md");
  assert.equal(seen["written.md"], "from the child");
}

// A child that writes its real output somewhere else than its output path
// gets the reply in its output; the flag says the file carries no child work.
{
  const dir = path.join(tmp, "wrongpath");
  fs.mkdirSync(dir);
  const given = path.join(dir, "given.md");
  const stray = path.join(dir, "stray.md");
  const harness = fakeHarness(async () => {
    fs.writeFileSync(stray, "the real output");
    return { finalText: "the reply" };
  });
  const { port } = setup("wrongpath", { harness });
  const result = await port.runOne(item("w", { output: given }));
  assert.equal(result.outputFromReply, true);
  assert.equal(fs.readFileSync(given, "utf8"), "the reply");
  assert.equal(fs.readFileSync(stray, "utf8"), "the real output");
}

// maxChildren gives skipped; so do an unknown role and an unknown resume id.
{
  const harness = fakeHarness(() => ({}));
  const { port, runDir } = setup("caps", { harness, maxChildren: 2 });
  const results = await port.runMany([item("a"), item("b"), item("c")]);
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "skipped"]);
  assert.match(results[2].error, /child limit/);
  assert.equal(harness.calls.length, 2);
  const role = await port.runOne(item("d", { agent: "nobody" }));
  assert.equal(role.status, "skipped");
  const open = setup("caps2", { harness });
  assert.match((await open.port.runOne(item("d", { agent: "nobody" }))).error, /unknown role: nobody/);
  const unknown = await open.port.runOne(item("e", { resume: "nope" }));
  assert.equal(unknown.status, "skipped");
  assert.match(unknown.error, /unknown resume id/);
  assert.equal(readLog(runDir).filter((r) => r.type === "settle").length, 2);
}

// Stopping: the killed child is aborted with no gate or settle record, and
// later items start nothing.
{
  const controller = new AbortController();
  const harness = fakeHarness(async (spec) => {
    if (spec.item.key === "slow") {
      await new Promise((resolve) => spec.signal.addEventListener("abort", resolve, { once: true }));
      return { status: "aborted", finalText: "" };
    }
    return {};
  });
  const { port, runDir, gates } = setup("stop", { harness, signal: controller.signal });
  const gate = { command: "check" };
  const batch = port.runMany([item("quick", { gate }), item("slow", { gate })]);
  await sleep(50);
  controller.abort();
  const [quick, slow] = await batch;
  assert.equal(quick.status, "done");
  assert.equal(slow.status, "aborted");
  assert.equal(slow.ok, false);
  const later = await port.runOne(item("later", { gate }));
  assert.equal(later.status, "aborted");
  assert.deepEqual(gates.map((g) => g.item.key), ["quick"]);
  assert.deepEqual(harness.calls.map((c) => c.item.key), ["quick", "slow"]);
  const log = readLog(runDir);
  assert.deepEqual(log.filter((r) => r.type === "settle").map((r) => r.key), ["quick"]);
  assert.equal(log.some((r) => r.key === "later"), false);
  assert.deepEqual(log.filter((r) => r.type === "end").map((r) => r.key).sort(), ["quick", "slow"]);
}

// children.jsonl and the index; replay returns the same results without a child.
{
  const harness = fakeHarness((spec) => ({ finalText: `reply ${spec.item.key}`, sessionFile: `/s/${spec.runId}.jsonl` }));
  const { port, runDir, stateDir, gates } = setup("replay", { harness });
  const items = [item("a", { gate: { command: "x" } }), item("b"), item("a", { gate: { command: "x" } })];
  const results = [];
  for (const it of items) results.push(await port.runOne(it));
  const log = readLog(runDir);
  assert.deepEqual(log.map((r) => r.type), ["start", "end", "settle", "start", "end", "settle", "start", "end", "settle"]);
  const start = log[0];
  assert.equal(start.key, "a");
  assert.equal(start.role, "writer");
  assert.equal(start.harness, "fake");
  assert.equal(start.sessionId, start.runId);
  assert.equal(start.sessionDir, path.join(runDir, "sessions"));
  assert.equal(log[2].fingerprint, fingerprint(items[0]));
  assert.equal(log[2].fingerprint, log[8].fingerprint);
  assert.notEqual(log[2].runId, log[8].runId);
  const index = JSON.parse(fs.readFileSync(path.join(stateDir, "children", `${start.runId}.json`), "utf8"));
  assert.equal(index.pid, null);
  assert.equal(index.role, "writer");
  assert.equal(index.sessionFile, `/s/${start.runId}.jsonl`);

  const again = setup("replay-again", { harness });
  const second = again.make({ replay: log, deps: { runGate: async () => assert.fail("gate must not run") } });
  const before = harness.calls.length;
  const replayed = [];
  for (const it of items) replayed.push(await second.runOne(it));
  assert.equal(harness.calls.length, before);
  assert.deepEqual(replayed.map(({ replayed: r, ...rest }) => [r, rest]), results.map((r) => [true, JSON.parse(JSON.stringify(r))]));
  assert.notEqual(replayed[0].runId, replayed[2].runId);
  assert.equal(gates.length, 2);
  assert.equal((await second.runOne(items[1])).replayed, undefined);
}

// Stop part way, resume: the settled child is replayed, the unfinished one
// runs again and its gate runs once.
{
  const controller = new AbortController();
  let stopping = true;
  const harness = fakeHarness(async (spec) => {
    if (spec.item.key === "second" && stopping) {
      await new Promise((resolve) => spec.signal.addEventListener("abort", resolve, { once: true }));
      return { status: "aborted", finalText: "" };
    }
    return {};
  });
  const first = setup("resume", { harness, signal: controller.signal });
  const gate = { command: "check" };
  const run = async (port) => port.runMany([item("first", { gate }), item("second", { gate })]);
  const pending = run(first.port);
  await sleep(50);
  controller.abort();
  const stoppedResults = await pending;
  assert.deepEqual(stoppedResults.map((r) => r.status), ["done", "aborted"]);
  assert.equal(first.gates.length, 1);

  stopping = false;
  const calls = harness.calls.length;
  const resumed = first.make({ signal: undefined, replay: readLog(first.runDir), deps: {} });
  const results = await run(resumed);
  assert.deepEqual(results.map((r) => [r.status, r.replayed]), [["done", true], ["done", undefined]]);
  assert.equal(harness.calls.length, calls + 1);
  assert.equal(harness.calls.at(-1).item.key, "second");
  assert.deepEqual(first.gates.map((g) => g.item.key), ["first", "second"]);
}

// A resumed item keeps the original session and directory under a new run id.
{
  const harness = fakeHarness((spec) => ({ sessionFile: `/s/${spec.sessionId}.jsonl` }));
  const { port, runDir, stateDir } = setup("session", { harness });
  const first = await port.runOne(item("one", { worktree: true }));
  const second = await port.runOne(item("two", { agent: undefined, resume: first.runId }));
  assert.notEqual(second.runId, first.runId);
  const spec = harness.calls[1];
  assert.equal(spec.sessionId, first.runId);
  assert.equal(spec.sessionDir, path.join(runDir, "sessions"));
  assert.equal(spec.sessionFile, `/s/${first.runId}.jsonl`);
  assert.equal(spec.cwd, first.cwd);
  const starts = readLog(runDir).filter((r) => r.type === "start");
  assert.equal(starts[1].runId, second.runId);
  assert.equal(starts[1].sessionId, first.runId);
  assert.equal(starts[1].sessionDir, starts[0].sessionDir);
  assert.equal(starts[1].worktree, starts[0].worktree);
  assert.equal(starts[1].branch, starts[0].branch);
  assert.equal(starts[1].cwd, starts[0].cwd);
  const index = JSON.parse(fs.readFileSync(path.join(stateDir, "children", `${second.runId}.json`), "utf8"));
  assert.equal(index.sessionId, first.runId);
  assert.equal(index.sessionDir, starts[0].sessionDir);
  assert.equal(second.worktree, first.worktree);
}

// killUnfinished kills a recorded live child and leaves a reused pid alone.
{
  const runDir = path.join(tmp, "kill", "runner");
  const stateDir = path.join(tmp, "kill", "state");
  const live = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const reused = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const finished = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    const row = (key, proc, pidStart) => ({ type: "start", key, runId: key, pid: proc.pid, pidStart, at: "t" });
    const lines = [
      row("live", live, procStartTime(live.pid)),
      row("reused", reused, "1"),
      row("finished", finished, procStartTime(finished.pid)),
      { type: "end", key: "finished", runId: "finished", at: "t" },
    ];
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "children.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const killed = await killUnfinished(runDir, { stateDir, graceMs: 200 });
    assert.deepEqual(killed, ["live"]);
    await sleep(100);
    const alive = (proc) => spawnSync("kill", ["-0", String(proc.pid)]).status === 0 && !/^Z/.test(fs.readFileSync(`/proc/${proc.pid}/stat`, "utf8").split(") ")[1]);
    assert.equal(alive(live), false);
    assert.equal(alive(reused), true);
    assert.equal(alive(finished), true);
    const ends = readLog(runDir).filter((r) => r.type === "end").map((r) => r.runId);
    assert.deepEqual(ends, ["finished", "live", "reused"]);
    assert.deepEqual(await killUnfinished(runDir), []);
  } finally {
    for (const proc of [live, reused, finished]) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }
  }
}

// The child's environment names its role and output, and its budget when the role has one.
{
  const budget = { tokens: 100000, reserve: 30000, action: "commit" };
  const harness = fakeHarness(() => ({}));
  const config = { roles: { writer: { ...roles.writer, budget }, reader: roles.reader } };
  const { port, dir } = setup("env", { harness, config, env: { KEEP: "1" } });
  const output = path.join(dir, "out.md");
  await port.runMany([item("w", { output }), item("r", { agent: "reader" })]);
  const [w, r] = harness.calls;
  assert.deepEqual(w.env, {
    KEEP: "1",
    RECIPE_ROLE: "writer",
    RECIPE_OUTPUT: output,
    RECIPE_BUDGET_TOKENS: "100000",
    RECIPE_BUDGET_RESERVE: "30000",
    RECIPE_HANDOFF_ACTION: "commit",
  });
  assert.deepEqual(w.budget, budget);
  assert.deepEqual(r.env, { KEEP: "1", RECIPE_ROLE: "reader" });
  assert.equal(r.budget, null);
}

// A child that replies with a handoff line completed; the line, its unread inputs and its note ride on the Result.
{
  const reply = {
    w: "handoff: half done; the parser is left",
    r: "handoff: read two of four\nunread: a.md, b.md\n- unread: `c.md`",
    p: "handoff: no file",
  };
  const harness = fakeHarness(async (spec) => {
    if (spec.item.output) fs.writeFileSync(spec.item.output, reply[spec.item.key]);
    return { finalText: reply[spec.item.key] };
  });
  const { port, dir } = setup("handoff", { harness });
  const [w, r, p] = await port.runMany([
    item("w", { output: path.join(dir, "w.md") }),
    item("r", { agent: "reader", output: path.join(dir, "r.md") }),
    item("p", { agent: "reader" }),
  ]);
  assert.equal(w.status, "done");
  assert.equal(w.ok, true);
  assert.equal(w.error, undefined);
  assert.deepEqual(w.handoff, { line: reply.w, unread: [], note: path.join(dir, "w.md"), empty: false });
  assert.deepEqual(r.handoff.unread, ["a.md", "b.md", "c.md"]);
  assert.equal(r.handoff.note, path.join(dir, "r.md"));
  assert.deepEqual(p.handoff, { line: reply.p, unread: [], note: null, empty: true });
  const plain = await setup("plain", { harness: fakeHarness(() => ({})) }).port.runOne(item("x"));
  assert.equal(plain.handoff, null);
  assert.equal(plain.budget, null);
  assert.deepEqual(readLog(path.join(dir, "runner")).map((l) => l.type).filter((t) => !["start", "end", "settle"].includes(t)), []);
}

// A valve-ended child whose note starts with handoff: is a handoff; one that wrote nothing is judged by its commits.
{
  const budget = { tokens: 100000, reserve: 30000, action: "commit" };
  const valve = { fired: true, tokens: 100500, budget: 100000, action: "commit", ended: true };
  const ended = { status: "failed", error: "ended by the valve", finalText: "", valve };
  const harness = fakeHarness(async (spec) => {
    if (spec.item.key === "noted") fs.writeFileSync(spec.item.output, "handoff: Done x, left y\n\nDone\n- x\n");
    if (spec.item.key === "plainfile") fs.writeFileSync(spec.item.output, "partial findings only\n");
    return ended;
  });
  const config = { roles: { writer: { ...roles.writer, budget }, reader: roles.reader } };
  const committed = (commits) => ({ worktrees: { make: ({ item: i }) => ({ ok: true, worktree: `/wt/${i.key}`, branch: `recipe/${i.key}`, head: "base1" }), state: () => ({ exists: true, clean: false, commits }), remove: () => ({ ok: true }) } });

  const first = setup("valve-note", { harness, config, deps: committed(0) });
  const noted = await first.port.runOne(item("noted", { output: path.join(first.dir, "noted.md"), worktree: true }));
  assert.equal(noted.status, "done");
  assert.equal(noted.ok, true);
  assert.equal(noted.error, undefined);
  assert.equal(noted.handoff.line, "handoff: Done x, left y");
  assert.equal(noted.handoff.note, path.join(first.dir, "noted.md"));
  assert.equal(noted.handoff.empty, false);

  const second = setup("valve-empty", { harness, config, deps: committed(2) });
  const empty = await second.port.runOne(item("none", { worktree: true }));
  assert.equal(empty.status, "done");
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.handoff, { line: "handoff: ended by the context valve before its note", unread: [], note: null, empty: true });
  const partial = await second.port.runOne(item("plainfile", { output: path.join(second.dir, "plain.md"), worktree: true }));
  assert.equal(partial.status, "done");
  assert.equal(partial.handoff.empty, true);
  assert.equal(partial.handoff.note, null);

  const third = setup("valve-none", { harness, config, deps: committed(0) });
  const lost = await third.port.runOne(item("none", { worktree: true }));
  assert.equal(lost.status, "failed");
  assert.equal(lost.ok, false);
  assert.equal(lost.error, "context budget reached and no handoff was written");
  assert.equal(lost.handoff, null);
  const bare = await third.port.runOne(item("nowt"));
  assert.equal(bare.status, "failed");
  assert.equal(bare.error, "context budget reached and no handoff was written");
}

// A reviewer ended by the valve after one write keeps every unread line, even past the first 4 KB of its note.
{
  const valve = { fired: true, tokens: 131000, budget: 130000, action: "unread", ended: true };
  const harness = fakeHarness((spec) => {
    const body = "- a finding with some detail about the code\n".repeat(150);
    fs.writeFileSync(spec.item.output, `handoff: reviewed a.mjs; b.mjs and c.mjs left\n\n## Findings\n${body}\nunread: b.mjs\nunread: c.mjs\n`);
    return { status: "failed", error: "aborted", finalText: "", valve };
  });
  const budget = { tokens: 130000, reserve: 40000, action: "unread" };
  const config = { roles: { reviewer: { prompt: "p", tools: [], thinking: "low", acceptance: null, budget } } };
  const { port, dir } = setup("valve-unread", { harness, config });
  const output = path.join(dir, "review.md");
  const r = await port.runOne(item("review", { agent: "reviewer", output }));
  assert.ok(fs.statSync(output).size > 4096);
  assert.equal(r.status, "done");
  assert.deepEqual(r.handoff, { line: "handoff: reviewed a.mjs; b.mjs and c.mjs left", unread: ["b.mjs", "c.mjs"], note: output, empty: false });
}

// A valve-ended child without commits that wrote output but no handoff line: stop and unread roles keep the output as a handoff with no unread list; empty output, or a commit role, fails.
{
  const valve = (action) => ({ fired: true, tokens: 100500, budget: 100000, action, ended: true });
  const harness = fakeHarness((spec) => {
    const text = spec.item.key.startsWith("blank") ? "  \n" : "findings without a first line\n";
    fs.writeFileSync(spec.item.output, text);
    return { status: "failed", error: "aborted", finalText: "", valve: valve(spec.roleName === "builder" ? "commit" : "stop") };
  });
  const role = (action) => ({ prompt: "p", tools: [], thinking: "low", acceptance: null, budget: { tokens: 100000, reserve: 20000, action } });
  const config = { roles: { scout: role("stop"), reviewer: role("unread"), builder: role("commit") } };
  const { port, dir } = setup("valve-unmarked", { harness, config });
  const out = (name) => path.join(dir, `${name}.md`);
  for (const agent of ["scout", "reviewer"]) {
    const r = await port.runOne(item(`kept-${agent}`, { agent, output: out(`kept-${agent}`) }));
    assert.equal(r.status, "done");
    assert.equal(r.handoff, null);
  }
  const blank = await port.runOne(item("blank", { agent: "scout", output: out("blank") }));
  assert.equal(blank.status, "failed");
  assert.equal(blank.error, "context budget reached and no handoff was written");
  assert.equal(blank.handoff, null);
  const commit = await port.runOne(item("kept-builder", { agent: "builder", output: out("kept-builder") }));
  assert.equal(commit.status, "failed");
  assert.equal(commit.handoff, null);
}

// A timeout stays a timeout even with a handoff line.
{
  const harness = fakeHarness(() => ({ status: "timeout", finalText: "handoff: ran out of time" }));
  const { port } = setup("handoff-timeout", { harness });
  const late = await port.runOne(item("late"));
  assert.equal(late.status, "timeout");
  assert.equal(late.ok, false);
  assert.match(late.error, /timed out after/);
  assert.equal(late.handoff.line, "handoff: ran out of time");
}

// A looped child that wrote its output itself settles done with its gate run,
// even with empty final text, and its loop rides on the result and the settle
// record; one whose done line was mid-loop text without the file, and one that
// wrote nothing, fail with the harness's error; none is aborted.
{
  const loop = { tool: "bash", repeats: 4 };
  const loopError = `repeated ${loop.tool} ${loop.repeats} times with the same result`;
  const looped = (finalText) => ({ status: "looped", error: loopError, loop, finalText });
  const harness = fakeHarness((spec) => {
    if (["delivered", "concerns", "silent"].includes(spec.item.key)) fs.writeFileSync(spec.item.output, "the report\n");
    const text = {
      delivered: "done",
      concerns: "done, concerns",
      unwritten: "done\n\n`out.md`",
    }[spec.item.key] ?? "";
    return looped(text);
  });
  const { port, runDir, dir, gates } = setup("looped", { harness });
  const gate = { command: "check" };
  const out = (name) => path.join(dir, `${name}.md`);
  const delivered = await port.runOne(item("delivered", { output: out("delivered"), gate }));
  assert.equal(delivered.status, "done");
  assert.equal(delivered.ok, true);
  assert.equal(delivered.error, undefined);
  assert.deepEqual(delivered.loop, loop);
  assert.equal(delivered.handoff, null);
  const concerns = await port.runOne(item("concerns", { output: out("concerns") }));
  assert.equal(concerns.status, "done");
  assert.equal(concerns.ok, true);
  const silent = await port.runOne(item("silent", { output: out("silent"), gate }));
  assert.equal(silent.status, "done");
  assert.equal(silent.ok, true);
  assert.equal(silent.error, undefined);
  assert.deepEqual(silent.loop, loop);
  assert.equal(silent.handoff, null);
  assert.equal(silent.outputFromReply, false);
  const unwritten = await port.runOne(item("unwritten", { output: out("unwritten") }));
  assert.equal(unwritten.status, "failed");
  assert.equal(unwritten.ok, false);
  assert.equal(unwritten.error, loopError);
  assert.deepEqual(unwritten.loop, loop);
  assert.equal(unwritten.handoff, null);
  assert.equal(unwritten.outputFromReply, true);
  const bare = await port.runOne(item("noth"));
  assert.equal(bare.status, "failed");
  assert.equal(bare.ok, false);
  assert.equal(bare.error, loopError);
  assert.deepEqual(bare.loop, loop);
  assert.equal(bare.handoff, null);
  assert.ok(bare.runId);
  assert.deepEqual(gates.map((g) => g.item.key), ["delivered", "silent"]);
  const settled = readLog(runDir).filter((r) => r.type === "settle");
  assert.deepEqual(settled.map((r) => [r.key, r.result.status, r.result.loop]), [
    ["delivered", "done", loop],
    ["concerns", "done", loop],
    ["silent", "done", loop],
    ["unwritten", "failed", loop],
    ["noth", "failed", loop],
  ]);
  assert.ok(settled.every((r) => r.result.status !== "aborted"));
}

// A looped implementer whose worktree has commits gets no handoff and so no relay.
{
  const loop = { tool: "bash", repeats: 4 };
  const budget = { tokens: 100000, reserve: 30000, action: "commit" };
  const harness = fakeHarness(() => ({
    status: "looped",
    error: `repeated ${loop.tool} ${loop.repeats} times with the same result`,
    loop,
    finalText: "handoff: left the work half committed",
  }));
  const config = { roles: { implementer: { prompt: "p", tools: [], thinking: "low", acceptance: null, budget } } };
  const worktrees = {
    make: ({ item: i }) => ({ ok: true, worktree: `/wt/${i.key}`, branch: `recipe/${i.key}`, head: "base1" }),
    state: () => ({ exists: true, clean: false, commits: 2 }),
    remove: () => ({ ok: true }),
  };
  const { port, runDir } = setup("looped-implementer", { harness, config, deps: { worktrees } });
  const r = await port.runOne(item("impl", { agent: "implementer", worktree: true }));
  assert.equal(r.status, "failed");
  assert.equal(r.handoff, null);
  assert.deepEqual(r.loop, loop);
  assert.equal(r.worktree, "/wt/impl");
  const settled = readLog(runDir).filter((rec) => rec.type === "settle");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].result.handoff, null);
}

// The outcome record lands in the child's transcript; a successor's handoff-outcome lands in the predecessor's.
{
  const budget = { tokens: 100000, reserve: 30000, action: "commit" };
  const config = { roles: { writer: { ...roles.writer, budget }, reader: roles.reader } };
  const harness = fakeHarness((spec) => {
    if (spec.item.key === "first") {
      return { finalText: "handoff: more to do", usage: { ...usage, peakContext: 101000, firstContext: 60000 }, valve: { fired: true, tokens: 101000, budget: 100000, action: "commit", ended: false } };
    }
    return { usage: { ...usage, peakContext: 40000 } };
  });
  const { port, runDir, stateDir } = setup("outcome", { harness, config });
  const first = await port.runOne(item("first"));
  const second = await port.runOne(item("second", { handoffOf: first.runId, handoffAs: "relay" }));
  const third = await port.runOne(item("third", { agent: "reader", handoffOf: "unknown-run", handoffAs: "split" }));
  const records = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const transcriptOf = (result) => JSON.parse(fs.readFileSync(path.join(stateDir, "children", `${result.runId}.json`), "utf8")).transcriptFile;
  const starts = readLog(runDir).filter((r) => r.type === "start");
  assert.equal(starts[0].transcriptFile, transcriptOf(first));
  assert.equal(starts[0].transcriptFile, harness.calls[0].transcriptFile);
  assert.deepEqual(records(transcriptOf(first)), [
    { recordType: "outcome", runId: first.runId, role: "writer", peakContext: 101000, firstContext: 60000, budget: 100000, valve: true, handoff: true },
    { recordType: "handoff-outcome", runId: first.runId, as: "relay", by: second.runId },
  ]);
  assert.deepEqual(records(transcriptOf(second)), [
    { recordType: "outcome", runId: second.runId, role: "writer", peakContext: 40000, firstContext: 40000, budget: 100000, valve: false, handoff: false },
  ]);
  assert.deepEqual(records(transcriptOf(third)).map((r) => r.budget), [null]);
  const handoffs = readLog(runDir).filter((r) => r.type === "handoff");
  assert.deepEqual(
    handoffs.map(({ at: _at, ...rest }) => rest),
    [
      { type: "handoff", key: "second", runId: first.runId, as: "relay", by: second.runId },
      { type: "handoff", key: "third", runId: "unknown-run", as: "split", by: third.runId },
    ],
  );
  assert.equal(fingerprint(item("k")), fingerprint(item("k", { handoffOf: "x", handoffAs: "relay" })));
}

// A second onSpawn rewrites the index pid and leaves a respawn record; killUnfinished goes for the latest pid.
{
  const first = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const second = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  let seen = null;
  const spawning = {
    async start(spec) {
      spec.onSpawn({ pid: first.pid });
      spec.onSpawn({ pid: second.pid });
      seen = {
        index: JSON.parse(fs.readFileSync(path.join(stateDirOf, "children", `${spec.runId}.json`), "utf8")),
        log: readLog(runDirOf),
      };
      return { status: "done", exitCode: 0, signal: null, stopReason: "stop", finalText: "ok", usage, sessionFile: null, ms: 1 };
    },
  };
  const dir = path.join(tmp, "respawn");
  const runDirOf = path.join(dir, "runner");
  const stateDirOf = path.join(dir, "state");
  try {
    const port = createPort({ runDir: runDirOf, cwd: dir, config: { stateDir: stateDirOf, roles }, harnessName: "fake", harness: spawning });
    const result = await port.runOne(item("respawned"));
    assert.equal(result.status, "done");
    assert.equal(seen.index.pid, second.pid);
    assert.equal(seen.index.pidStart, procStartTime(second.pid));
    const respawns = seen.log.filter((r) => r.type === "respawn");
    assert.equal(respawns.length, 1);
    assert.deepEqual({ ...respawns[0], at: undefined }, { type: "respawn", key: "respawned", runId: result.runId, pid: second.pid, pidStart: procStartTime(second.pid), at: undefined });
    assert.equal(readLog(runDirOf).filter((r) => r.type === "start").length, 1);
    const final = JSON.parse(fs.readFileSync(path.join(stateDirOf, "children", `${result.runId}.json`), "utf8"));
    assert.equal(final.pid, null);

    const killDir = path.join(dir, "kill", "runner");
    const spare = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const row = (type, runId, proc, pidStart) => ({ type, key: runId, runId, pid: proc.pid, pidStart, at: "t" });
    const lines = [
      row("start", "moved", first, procStartTime(first.pid)),
      row("respawn", "moved", second, procStartTime(second.pid)),
      row("start", "reused", spare, procStartTime(spare.pid)),
      row("respawn", "reused", spare, "1"),
    ];
    try {
      fs.mkdirSync(killDir, { recursive: true });
      fs.writeFileSync(path.join(killDir, "children.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      assert.deepEqual(await killUnfinished(killDir, { graceMs: 200 }), ["moved"]);
      await sleep(100);
      const alive = (proc) => spawnSync("kill", ["-0", String(proc.pid)]).status === 0 && !/^Z/.test(fs.readFileSync(`/proc/${proc.pid}/stat`, "utf8").split(") ")[1]);
      assert.equal(alive(second), false);
      assert.equal(alive(first), true);
      assert.equal(alive(spare), true);
    } finally {
      process.kill(-spare.pid, "SIGKILL");
    }
  } finally {
    for (const proc of [first, second]) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }
  }
}

// Replay ignores respawn and handoff records and still hands back the settled result.
{
  const harness = fakeHarness(() => ({ finalText: "handoff: later" }));
  const original = setup("replay-handoff", { harness });
  const result = await original.port.runOne(item("a"));
  const records = readLog(original.runDir);
  records.splice(1, 0, { type: "respawn", key: "a", runId: result.runId, pid: 1, pidStart: "1", at: "t" }, { type: "handoff", key: "a", runId: "p", as: "relay", by: result.runId, at: "t" });
  const replayed = await setup("replay-handoff-2", { harness: fakeHarness(() => ({})), replay: records }).port.runOne(item("a"));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.handoff.line, "handoff: later");
}

// A worktree item gets a real worktree; a dispatched one is removed when untouched.
{
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const harness = fakeHarness((spec) => {
    if (spec.item.key === "dirty") fs.writeFileSync(path.join(spec.cwd, "new.txt"), "x");
    return {};
  });
  const dir = path.join(tmp, "real-wt");
  const make = (extra = {}) =>
    createPort({
      runDir: path.join(dir, "runner"),
      cwd: repo,
      config: { stateDir: path.join(dir, "state"), worktreeDir: path.join(dir, "worktrees"), roles },
      harnessName: "fake",
      harness,
      ...extra,
    });
  const kept = await make().runOne(item("kept", { worktree: true }));
  assert.equal(kept.status, "done");
  assert.equal(kept.worktree, harness.calls[0].cwd);
  assert.equal(kept.worktree, path.join(dir, "worktrees", "repo", kept.runId));
  assert.equal(kept.branch, `recipe/${kept.runId}`);
  assert.equal(git(kept.worktree, "rev-parse", "--abbrev-ref", "HEAD"), kept.branch);
  assert.equal(fs.existsSync(path.join(kept.worktree, "a.txt")), true);

  const dispatch = make({ keepWorktrees: false });
  const clean = await dispatch.runOne(item("clean", { worktree: true }));
  assert.equal(fs.existsSync(clean.cwd), false);
  assert.equal(clean.worktree, null);
  const dirty = await dispatch.runOne(item("dirty", { worktree: true }));
  assert.equal(fs.existsSync(dirty.worktree), true);

  const bad = await make().runOne(item("bad", { worktree: true, baseRef: "no-such-ref" }));
  assert.equal(bad.status, "skipped");
  assert.match(bad.error, /worktree could not be made/);
}

// emit goes to onBoard.
{
  const seen = [];
  const { port } = setup("board", { harness: fakeHarness(() => ({})), onBoard: (view) => seen.push(view) });
  port.emit({ a: 1 });
  assert.deepEqual(seen, [{ a: 1 }]);
}

// The fake helpers: portOf and a graph through the real port.
{
  const runs = {
    all: async (items) => items.map((it) => ({ ok: it.key !== "no", error: it.key === "no" ? "bad" : undefined, structuredOutput: { k: it.key } })),
  };
  const direct = portOf(runs);
  assert.deepEqual((await direct.runMany([{ key: "x" }])).map((r) => r.structuredOutput), [{ k: "x" }]);
  assert.equal((await direct.runOne({ key: "no" })).error, "bad");
  assert.equal(direct.emit({}), undefined);

  const deps = fakeDeps(runs);
  assert.equal(deps.newRunId({ key: "k" }), "run-k");
  const out = await runThroughRunner(
    async (args, port) => {
      assert.equal(Object.isFrozen(args), true);
      const [good, bad] = await port.runMany([
        { key: "good", agent: "scout", task: "t", gate: { command: "c", output: "json" } },
        { key: "no", agent: "implementer", task: "t" },
      ]);
      const fix = await port.runOne({ key: "fix", resume: good.runId, task: "t", gate: { command: "c" } });
      return { good, bad, fix, args };
    },
    runs,
    { n: 1 },
  );
  assert.deepEqual(out.good.structuredOutput, { k: "good" });
  assert.equal(out.good.runId, "run-good");
  assert.equal(out.bad.status, "failed");
  assert.equal(out.bad.error, "bad");
  assert.equal(out.fix.ok, true);
  assert.equal(out.fix.cwd, "/wt/run-good");

  const peaks = {
    all: async (items) =>
      items.map(() => ({
        ok: true,
        finalText: "handoff: peaked",
        usage: { ...usage, peakContext: 90000 },
        valve: { fired: true, tokens: 90000, budget: 80000, action: "stop", ended: false },
      })),
  };
  const scripted = await fakeDeps(peaks).harness.start({ item: { key: "p" }, runId: "p", roleName: "scout" });
  assert.equal(scripted.usage.peakContext, 90000);
  assert.equal(scripted.valve.fired, true);
  assert.equal("valve" in (await fakeDeps(runs).harness.start({ item: { key: "x" }, runId: "x", roleName: "scout" })), false);
}

// A role's own harness wins over the run's default; a role without one keeps
// the default, and the default never goes through loadHarness.
{
  const def = fakeHarness(() => ({}));
  const alpha = fakeHarness(() => ({}));
  const loads = [];
  const loadHarness = (name) => {
    loads.push(name);
    return Promise.resolve({ alpha }[name]);
  };
  const config = { roles: { ...roles, writer: { ...roles.writer, harness: "alpha" } } };
  const { port, runDir } = setup("role-harness", { harness: def, config, loadHarness });
  const [w, r] = await port.runMany([item("w"), item("r", { agent: "reader" })]);
  assert.ok(w.ok && r.ok);
  assert.deepEqual(alpha.calls.map((c) => c.item.key), ["w"]);
  assert.deepEqual(def.calls.map((c) => c.item.key), ["r"]);
  assert.deepEqual(loads, ["alpha"]);
  const starts = readLog(runDir).filter((rec) => rec.type === "start");
  assert.deepEqual(starts.map((s) => [s.key, s.harness]).sort(), [["r", "fake"], ["w", "alpha"]].sort());
}

// A resumed child runs on the harness recorded for it, even if the role's
// harness now names another.
{
  const alpha = fakeHarness(() => ({}));
  const beta = fakeHarness(() => ({}));
  const loadHarness = (name) => Promise.resolve({ alpha, beta }[name]);
  const first = setup("harness-resume", {
    harness: fakeHarness(() => ({})),
    config: { roles: { writer: { ...roles.writer, harness: "alpha" } } },
    loadHarness,
  });
  const done = await first.port.runOne(item("w"));
  assert.ok(done.ok);
  assert.equal(alpha.calls.length, 1);
  const second = setup("harness-resume-2", {
    harness: fakeHarness(() => ({})),
    config: { stateDir: first.stateDir, roles: { writer: { ...roles.writer, harness: "beta" } } },
    loadHarness,
  });
  const resumed = await second.port.runOne(item("again", { resume: done.runId }));
  assert.ok(resumed.ok);
  assert.equal(alpha.calls.length, 2);
  assert.equal(beta.calls.length, 0);
  const start = readLog(second.runDir).filter((rec) => rec.type === "start")[0];
  assert.equal(start.harness, "alpha");
  assert.equal(start.resumes, done.runId);
  const index = JSON.parse(fs.readFileSync(path.join(first.stateDir, "children", `${resumed.runId}.json`), "utf8"));
  assert.equal(index.harness, "alpha");
}

// The engine lock follows the child's harness: a big item on a harness that
// does not use the engine takes no lock, the same item on the run's default does.
{
  const locked = [];
  const bigLock = async (file) => {
    locked.push(file);
    return () => locked.push("released");
  };
  const off = fakeHarness(() => ({}), { usesEngine: false });
  const loadHarness = (name) => Promise.resolve({ off }[name]);
  const onEngine = setup("role-big-1", { harness: fakeHarness(() => ({})), deps: { bigLock } });
  await onEngine.port.runOne(item("big", { big: true }));
  assert.deepEqual(locked, [path.join(onEngine.stateDir, "big.lock"), "released"]);
  locked.length = 0;
  const offEngine = setup("role-big-2", {
    harness: fakeHarness(() => ({})),
    config: { roles: { writer: { ...roles.writer, harness: "off" } } },
    loadHarness,
    deps: { bigLock },
  });
  await offEngine.port.runOne(item("big", { big: true }));
  assert.deepEqual(locked, []);
  assert.equal(off.calls.length, 1);
}

// An unknown or invalid harness name fails only its own child and names it.
{
  const loads = [];
  const loadHarness = (name) => {
    loads.push(name);
    throw new Error(`no harness named ${name}`);
  };
  const missing = setup("harness-missing", {
    harness: fakeHarness(() => ({})),
    config: { roles: { ...roles, writer: { ...roles.writer, harness: "ghost" } } },
    loadHarness,
  });
  const [bad, good] = await missing.port.runMany([item("bad"), item("good", { agent: "reader" })]);
  assert.equal(bad.status, "failed");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no harness named ghost/);
  assert.ok(good.ok);
  assert.equal(good.status, "done");
  assert.deepEqual(loads, ["ghost"]);
  const invalid = setup("harness-invalid", {
    harness: fakeHarness(() => ({})),
    config: { roles: { writer: { ...roles.writer, harness: "../evil" } } },
    loadHarness,
  });
  const evil = await invalid.port.runOne(item("bad"));
  assert.equal(evil.status, "failed");
  assert.match(evil.error, /bad harness name: \.\.\/evil/);
  assert.deepEqual(loads, ["ghost"]);
}

// Each harness module is loaded once, however many children run on it.
{
  const loads = [];
  const alpha = fakeHarness(() => ({}));
  const beta = fakeHarness(() => ({}));
  const loadHarness = (name) => {
    loads.push(name);
    return Promise.resolve(name === "alpha" ? alpha : beta);
  };
  const config = {
    roles: {
      writer: { ...roles.writer, harness: "alpha" },
      reader: { ...roles.reader, harness: "beta" },
    },
  };
  const { port } = setup("harness-once", { harness: fakeHarness(() => ({})), config, loadHarness });
  const results = await port.runMany([item("w1"), item("w2"), item("r1", { agent: "reader" })]);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(loads.sort(), ["alpha", "beta"]);
  assert.equal(alpha.calls.length, 2);
  assert.equal(beta.calls.length, 1);
}

console.log("port tests passed");
