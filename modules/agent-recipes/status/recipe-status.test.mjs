/**
 * recipe-status against fake runner directories. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("./recipe-status.mjs", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-status-"));

function fakeRun(name, status, childLines) {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, "runner"), { recursive: true });
  fs.writeFileSync(path.join(d, "runner", "status.json"), JSON.stringify(status));
  if (childLines) fs.writeFileSync(path.join(d, "runner", "children.jsonl"), childLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return d;
}

const status = (board, extra) => ({
  recipe: "implement",
  state: "running",
  pid: process.pid,
  startedAt: "2026-10-20T12:00:00Z",
  board,
  ...extra,
});
const run = (...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const u = (prompt, cached, output, peakContext) => ({ prompt, cached, output, peakContext });

// A running implement run: its board, the children still running, a retried
// child that does not count as failed, and usage totals over the settles.
const impl = fakeRun(
  "impl",
  status({
    stage: "wave 1, round 2",
    tasks: [
      { id: "stage-loop", state: "done", next: null, fixes: 0, heals: 0 },
      { id: "stage-check", state: "running", next: "fix", fixes: 1, heals: 1 },
    ],
    healed: [{ id: "stage-check", step: "implement", action: "replan", reason: "owns the test" }],
    decide: [{ id: "other", question: "pick a name", diagnosis: "/t/p/diagnosis-other-1.md" }],
  }),
  [
    { type: "start", key: "impl-stage-loop" },
    { type: "settle", key: "impl-stage-loop", result: { ok: true, status: "done", usage: u(1000, 800, 50, 900) } },
    { type: "start", key: "impl-stage-check" },
    { type: "settle", key: "impl-stage-check", result: { ok: false, status: "failed", usage: u(500, 100, 20, 1500) } },
    { type: "start", key: "fix-stage-check-1" },
    { type: "settle", key: "review-stage-loop-1", result: { ok: false, status: "failed" } },
    { type: "settle", key: "review-stage-loop-1-retry", result: { ok: true, status: "done", usage: u(10, 0, 5, 300) } },
  ],
);
{
  const r = run(impl + "/");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], impl);
  assert.match(lines[1], new RegExp(`^run ${process.pid}: running, started 2026-10-20 12:00 UTC, \\d+ min$`));
  assert.equal(lines[2], "stage: wave 1, round 2");
  assert.equal(lines[3], "  stage-loop           done");
  assert.equal(lines[4], "  stage-check          running, next fix (1 fix rounds, 1 diagnoses)");
  assert.equal(lines[5], "  healed stage-check: replan, owns the test");
  assert.equal(lines[6], "  decide other: pick a name");
  assert.equal(lines[7], "children: 1 running (fix-stage-check-1), 4 settled, failed: impl-stage-check");
  assert.equal(lines[8], "usage: prompt 1510, cached 900, output 75, peak context 1500");

  const j = JSON.parse(run(impl, "--json").out);
  assert.equal(j.state, "running");
  assert.equal(j.pid, process.pid);
  assert.equal(j.board.stage, "wave 1, round 2");
  assert.deepEqual(j.children, { running: ["fix-stage-check-1"], stopped: [], done: 4, failed: ["impl-stage-check"] });
  assert.deepEqual(j.usage, u(1510, 900, 75, 1500));
}

// A finished run reports its length from its last update; plan and research
// runs show their own board shapes.
const plan = fakeRun(
  "plan",
  status(
    { stage: "finished", tasks: 2, plan_ok: true, review: "clean", healed: [], decide: [] },
    { state: "complete", lastUpdate: "2026-10-20T12:07:00Z" },
  ),
);
const research = fakeRun(
  "research",
  status({ stage: "extracting", sources: { ok: 3, failed: 1, over_cap: 0 }, gap_round: false, healed: [], decide: [] }),
);
{
  const p = run(plan).out.trim().split("\n");
  assert.equal(p[1], `run ${process.pid}: complete, started 2026-10-20 12:00 UTC, 7 min`);
  assert.equal(p[3], "  plan: 2 tasks, check ok, review clean");
  assert.equal(p[4], "children: 0 running, 0 settled");
  assert.equal(p[5], "usage: prompt 0, cached 0, output 0, peak context 0");
  const r = run(research).out.trim().split("\n");
  assert.equal(r[2], "stage: extracting");
  assert.equal(r[3], "  sources: 3 ok, 1 failed, 0 over the cap");
}

// A running state whose process is gone: the pid of a child that has exited.
{
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const gone = fakeRun("gone", status(null, { pid: dead.pid }));
  assert.match(run(gone).out, /^run \d+: stopped \(process gone\), started/m);
  assert.equal(JSON.parse(run(gone, "--json").out).state, "stopped (process gone)");
}

// A stopped run shows the stop reason the runner recorded.
{
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const d = fakeRun("stopped-reason", status(null, { state: "stopped", pid: dead.pid, error: "stop requested (process gone)" }));
  assert.match(run(d).out, /^run \d+: stopped \(stop requested \(process gone\)\), started/m);
  const j = JSON.parse(run(d, "--json").out);
  assert.equal(j.state, "stopped");
  assert.equal(j.reason, "stop requested (process gone)");
}

// After a stop, a child with an end and no settle is stopped; while the run still
// goes it may be in its gate and counts as running; a restarted one runs again.
{
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const lines = [
    { type: "start", key: "a", runId: "r-a" },
    { type: "end", key: "a", runId: "r-a" },
    { type: "settle", key: "a", result: { ok: true } },
    { type: "start", key: "b", runId: "r-b" },
    { type: "end", key: "b", runId: "r-b" },
    { type: "start", key: "c", runId: "r-c1" },
    { type: "end", key: "c", runId: "r-c1" },
    { type: "start", key: "c", runId: "r-c2" },
  ];
  const stopped = fakeRun("stopped", status(null, { state: "stopped" }), lines);
  const j = JSON.parse(run(stopped, "--json").out);
  assert.deepEqual(j.children, { running: ["c"], stopped: ["b"], done: 1, failed: [] });
  assert.match(run(stopped).out, /^children: 1 running \(c\), 1 stopped \(b\), 1 settled$/m);
  const gone = fakeRun("gone2", status(null, { pid: dead.pid }), lines);
  assert.deepEqual(JSON.parse(run(gone, "--json").out).children.stopped, ["b"]);
  const going = fakeRun("going", status(null), lines);
  const g = JSON.parse(run(going, "--json").out).children;
  assert.deepEqual([g.running, g.stopped], [["b", "c"], []]);
}

// No board yet, no run at all, and a usage error.
{
  const fresh = fakeRun("fresh", status(null));
  assert.match(run(fresh).out, /^stage: no board yet$/m);
  const none = path.join(tmp, "none");
  const r = run(none);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `recipe-status: no run found for ${none} (no ${none}/runner/status.json)`);
  assert.equal(run().code, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-status: ok");
