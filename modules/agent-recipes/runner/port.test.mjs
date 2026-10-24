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
  const seen = Object.fromEntries(gates.map((g) => [path.basename(g.item.output), g.outputText]));
  assert.equal(seen["missing.md"], "reply for missing.md");
  assert.equal(seen["unchanged.md"], "reply for unchanged.md");
  assert.equal(seen["written.md"], "from the child");
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
}

console.log("port tests passed");
