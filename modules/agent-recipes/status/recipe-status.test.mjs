/**
 * recipe-status against fake pi-subagents run directories. Run by
 * `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("./recipe-status.mjs", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-status-"));
const root = path.join(tmp, "pi-subagents", "async-subagent-runs");

function fakeRun(id, status, childLines) {
  const d = path.join(root, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "status.json"), JSON.stringify(status));
  if (childLines) fs.writeFileSync(path.join(d, "workflow-children.jsonl"), childLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const status = (args, extra) => ({ state: "running", startedAt: Date.parse("2026-10-20T12:00:00Z"), workflow: { args, emits: [] }, ...extra });
const run = (...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// An implement run: the newest run for the plan directory, its board and the
// children still running.
fakeRun("old", status({ plan: "/t/p" }, { startedAt: Date.parse("2026-10-19T12:00:00Z"), state: "complete" }));
fakeRun(
  "new",
  status(
    { plan: "/t/p/", repo: "/r" },
    {
      workflow: {
        args: { plan: "/t/p/", repo: "/r" },
        emits: [
          { stage: "plan accepted", tasks: [], healed: [], decide: [] },
          {
            stage: "wave 1, round 2",
            tasks: [
              { id: "stage-loop", state: "done", next: null, fixes: 0, heals: 0 },
              { id: "stage-check", state: "running", next: "fix", fixes: 1, heals: 1 },
            ],
            healed: [{ id: "stage-check", step: "implement", action: "replan", reason: "owns the test" }],
            decide: [{ id: "other", question: "pick a name", diagnosis: "/t/p/diagnosis-other-1.md" }],
          },
        ],
      },
    },
  ),
  [
    { type: "start", key: "impl-stage-loop" },
    { type: "settle", key: "impl-stage-loop", result: { ok: true } },
    { type: "start", key: "impl-stage-check" },
    { type: "settle", key: "impl-stage-check", result: { ok: false } },
    { type: "start", key: "fix-stage-check-1" },
    { type: "settle", key: "review-stage-loop-1", result: { ok: false } },
    { type: "settle", key: "review-stage-loop-1-retry", result: { ok: true } },
  ],
);
fakeRun("other", status({ dir: "/t/elsewhere" }));
{
  const r = run("/t/p");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "/t/p");
  assert.match(lines[1], /^run new: running, started 2026-10-20 12:00 UTC, \d+ min$/);
  assert.equal(lines[2], "stage: wave 1, round 2");
  assert.equal(lines[3], "  stage-loop           done");
  assert.equal(lines[4], "  stage-check          running, next fix (1 fix rounds, 1 diagnoses)");
  assert.equal(lines[5], "  healed stage-check: replan, owns the test");
  assert.equal(lines[6], "  decide other: pick a name");
  assert.equal(lines[7], "children: 1 running (fix-stage-check-1), 4 settled, failed: impl-stage-check");

  const j = JSON.parse(run("/t/p/", "--json").out);
  assert.equal(j.run, "new");
  assert.equal(j.board.stage, "wave 1, round 2");
  assert.deepEqual(j.children, { running: ["fix-stage-check-1"], done: 4, failed: ["impl-stage-check"] });
}

// A plan run and a research run show their own board shapes; a finished run
// reports its length from its last update.
fakeRun(
  "plan",
  status(
    { dir: "/t/plan" },
    {
      state: "complete",
      lastUpdate: Date.parse("2026-10-20T12:07:00Z"),
      workflow: { args: { dir: "/t/plan" }, emits: [{ stage: "finished", tasks: 2, plan_ok: true, review: "clean", healed: [], decide: [] }] },
    },
  ),
);
fakeRun(
  "research",
  status(
    { dir: "/t/r" },
    { workflow: { args: { dir: "/t/r" }, emits: [{ stage: "extracting", sources: { ok: 3, failed: 1, over_cap: 0 }, gap_round: false, healed: [], decide: [] }] } },
  ),
);
{
  const p = run("/t/plan").out.trim().split("\n");
  assert.equal(p[1], "run plan: complete, started 2026-10-20 12:00 UTC, 7 min");
  assert.equal(p[3], "  plan: 2 tasks, check ok, review clean");
  assert.equal(p[4], "children: 0 running, 0 settled");
  const r = run("/t/r").out.trim().split("\n");
  assert.equal(r[2], "stage: extracting");
  assert.equal(r[3], "  sources: 3 ok, 1 failed, 0 over the cap");
}

// A run with no emit yet, no run at all, and a usage error.
fakeRun("fresh", status({ dir: "/t/fresh" }));
{
  assert.match(run("/t/fresh").out, /^stage: no board yet$/m);
  const none = run("/t/none");
  assert.equal(none.code, 1);
  assert.match(none.err, /no run found for \/t\/none/);
  assert.equal(run().code, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-status: ok");
