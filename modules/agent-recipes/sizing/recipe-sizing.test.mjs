/**
 * Behaviour tests for recipe-sizing against a synthetic transcript tree. Run
 * by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-sizing.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-sizing-"));
const sessions = path.join(tmp, "sessions", "--proj--", "subagent-artifacts");
fs.mkdirSync(sessions, { recursive: true });

let counter = 0;
const assistant = (input, cacheRead = 0) => ({
  recordType: "message",
  message: { role: "assistant", usage: { input, cacheRead, output: 100 } },
});
const readResult = (tokens) => ({
  recordType: "message",
  toolName: "read",
  text: "x".repeat(tokens * 4),
  message: { role: "toolResult" },
});
const bashResult = (tokens) => ({
  recordType: "message",
  toolName: "bash",
  text: "x".repeat(tokens * 4),
  message: { role: "toolResult" },
});
const transcriptIn = (dir, role, records, extra = "") => {
  const id = `00000000-0000-0000-0000-${String(counter++).padStart(12, "0")}`;
  const file = path.join(dir, `${id}_${role}_transcript.jsonl`);
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n" + extra;
  fs.writeFileSync(file, body);
  return file;
};
const transcript = (role, records, extra) => transcriptIn(sessions, role, records, extra);

// 25 runs under the old role name: peak = 7000 + 2 x read tokens, exactly.
for (let i = 0; i < 25; i++) {
  const r = 1000 * ((i % 5) + 1);
  transcript(
    "worker",
    [assistant(7000), readResult(r), bashResult(50_000), assistant(500, 6500 + r), assistant(500, 6500 + 2 * r)],
    i === 0 ? "not json\n" : "",
  );
}
// 20 reviewers: 4 compact (60k -> 20k, with one cold re-prefill), 16 stay at 30k.
for (let i = 0; i < 20; i++) {
  if (i < 4) transcript("reviewer", [assistant(7000), assistant(1000, 59000), assistant(20000)]);
  else transcript("reviewer", [assistant(7000), assistant(2000, 28000)]);
}
// Five scouts is below the threshold; a run with no assistant message counts for nothing.
for (let i = 0; i < 5; i++) transcript("scout", [assistant(7000), assistant(1000, 70000)]);
transcript("scout", [{ recordType: "message", message: { role: "user" } }]);

// Handoff records: one planner run is relayed, another split (three split records
// count once); a Claude-style run has only an outcome record; coders have 3 runs.
const outcome = (runId, handoff, budget) => ({ recordType: "outcome", runId, role: "x", peakContext: 1, firstContext: 1, budget, valve: false, handoff });
const handoffOutcome = (runId, as) => ({ recordType: "handoff-outcome", runId, as, by: "next" });
transcript("planner", [outcome("p1", true, 5000), handoffOutcome("p1", "relay")]);
transcript("planner", [outcome("p2", true, 6000), handoffOutcome("p2", "split"), handoffOutcome("p2", "split"), handoffOutcome("p2", "split")]);
transcript("planner", [outcome("p3", false, null)]);
transcript("planner", [assistant(7000), outcome("p4", false, 7000)]);
for (let i = 0; i < 3; i++) transcript("coder", [outcome(`c${i}`, i === 0, 9000)]);

const run = (args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};
const sizing = (...args) => run([path.join(tmp, "sessions"), ...args]);

// Without a current file: measured roles only, thin roles left out.
{
  const r = sizing("--engine-rev", "abc123");
  assert.equal(r.status, 0);
  assert.equal(r.json.engine_rev, "abc123");
  assert.deepEqual(Object.keys(r.json.roles).sort(), ["implementer", "reviewer"]);
  assert.match(r.stderr, /scout: 5 runs, below 20; left out/);
  assert.deepEqual(r.json.roles.implementer, {
    samples: 25,
    base: 7000,
    peak_p90: 17000,
    compact_rate: 0,
    cold_per_run: 0,
    k_read: 2,
    growth_p90: 0,
  });
  const reviewer = r.json.roles.reviewer;
  assert.equal(reviewer.samples, 20);
  assert.equal(reviewer.base, 7000);
  assert.equal(reviewer.peak_p90, 60000);
  assert.equal(reviewer.compact_rate, 0.2);
  assert.equal(reviewer.cold_per_run, 0.2);
  assert.equal("k_read" in reviewer, false);
  assert.equal("growth_p90" in reviewer, false);
  assert.deepEqual(r.json.handoffs, {
    planner: { runs: 4, handoff_rate: 0.5, relay_rate: 0.5, split_rate: 0.5, budget: 7000, low_samples: true },
    coder: { runs: 3, handoff_rate: 0.33, relay_rate: 0, split_rate: 0, budget: 9000, low_samples: true },
  });
  assert.equal("coder" in r.json.roles, false);
  assert.equal("reviewer" in r.json.handoffs, false);
}

// With a current file: defaults are replaced, measured values move at most x1.5,
// fields with no data and thin roles are kept.
const currentFile = path.join(tmp, "current.json");
fs.writeFileSync(
  currentFile,
  JSON.stringify({
    engine_rev: "old",
    roles: {
      implementer: { samples: 0, base: 7000, k_read: 1, growth_p90: 10000, peak_p90: 109000, compact_rate: 0.08, cold_per_run: 0.39 },
      reviewer: { samples: 30, base: 7000, k_read: 1, growth_p90: 10000, peak_p90: 30000, compact_rate: 0.1, cold_per_run: 0.1 },
      scout: { samples: 0, base: 7000, growth_p90: 119000, peak_p90: 126000, compact_rate: 0.08, cold_per_run: 0.08 },
    },
  }),
);
{
  const r = sizing("--current", currentFile);
  assert.equal(r.status, 0);
  assert.equal(r.json.engine_rev, "old");
  assert.deepEqual(r.json.roles.implementer, {
    samples: 25,
    base: 7000,
    k_read: 2,
    growth_p90: 0,
    peak_p90: 17000,
    compact_rate: 0,
    cold_per_run: 0,
  });
  assert.deepEqual(r.json.roles.reviewer, {
    samples: 20,
    base: 7000,
    k_read: 1,
    growth_p90: 10000,
    peak_p90: 45000,
    compact_rate: 0.15,
    cold_per_run: 0.15,
  });
  assert.equal(r.json.roles.scout.samples, 0);
  assert.equal(r.json.roles.scout.peak_p90, 126000);
  assert.match(r.stderr, /scout: 5 runs, below 20; kept/);
}

// A higher threshold keeps the reviewer's current entry as it was.
{
  const r = sizing("--current", currentFile, "--min-samples", "21");
  assert.equal(r.json.roles.reviewer.samples, 30);
  assert.equal(r.json.roles.reviewer.peak_p90, 30000);
  assert.equal(r.json.roles.implementer.samples, 25);
}

// Usage and IO errors.
{
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: recipe-sizing <sessions-dir>\.\.\. \[--current file\] \[--min-samples N\] \[--engine-rev REV\]/);
  assert.equal(sizing("--min-samples", "0").status, 2);
  assert.equal(sizing("--current").status, 2);
  assert.equal(sizing("--current", path.join(tmp, "absent.json")).status, 1);
}

// A child the runner ended for repeating the same turn is left out of every
// estimate and counted; the role's numbers are the normal child's alone.
transcript("extractor", [assistant(7000), assistant(1000, 40000), assistant(1000, 80000), outcome("e-looped", false, null)]);
transcript("extractor", [assistant(7000), assistant(1000, 7000), outcome("e-normal", false, null)]);
fs.writeFileSync(
  path.join(sessions, "children.jsonl"),
  [
    { type: "start", key: "e1", runId: "e-looped", role: "extractor" },
    {
      type: "settle",
      key: "e1",
      runId: "e-looped",
      fingerprint: "f1",
      at: "t",
      result: { status: "failed", error: "repeated bash 4 times with the same result", loop: { tool: "bash", repeats: 4 } },
    },
    { type: "start", key: "e2", runId: "e-normal", role: "extractor" },
    { type: "settle", key: "e2", runId: "e-normal", fingerprint: "f2", at: "t", result: { status: "done", loop: null } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
{
  const r = sizing("--min-samples", "1");
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.roles.extractor, {
    samples: 1,
    base: 7000,
    peak_p90: 8000,
    compact_rate: 0,
    cold_per_run: 0,
    growth_p90: 1000,
  });
  assert.deepEqual(r.json.looped, { extractor: 1 });
}

// Two sources pooled, one reached through a symlink; a symlinked directory and
// a symlinked file count once; integrate and resolve children are excluded
// and counted; and the implementer is fitted the way the plan gate spends it.
// Pairs (declared tokens, firstContext - base, base 7000): fit-a 1000, 6000
// (bytes recorded); fit-b 2000, 4000 (est 19000 with the default sizing);
// fit-c 2000, 5000 (est 22000 with the gate's sizing); fit-d has no
// impl-fit-d settle and is skipped. k = 24e6 / 9e6 = 2.67, growth is the p90
// of [3330, 0, 0] = 3330, and every pair is covered (fit-a exactly).
{
  const tree2 = path.join(tmp, "tree2");
  const innerDir = path.join(tmp, "inner");
  const realDir = path.join(tmp, "real");
  for (const dir of [tree2, innerDir, realDir]) fs.mkdirSync(dir, { recursive: true });
  transcriptIn(tree2, "implementer", [assistant(7000), assistant(1000, 7000), outcome("integrate-run", false, null)]);
  transcriptIn(tree2, "implementer", [assistant(7000), assistant(1000, 7000), outcome("resolve-run", false, null)]);
  transcriptIn(tree2, "locator", [assistant(7000), assistant(1000, 19000)]);
  transcriptIn(innerDir, "locator", [assistant(7000), assistant(1000, 19000)]);
  const pfit = path.join(sessions, "pfit");
  fs.mkdirSync(pfit, { recursive: true });
  fs.symlinkSync(innerDir, path.join(pfit, "inner-link"));
  const linkedReal = transcriptIn(realDir, "locator", [assistant(7000), assistant(1000, 19000)]);
  fs.symlinkSync(linkedReal, path.join(pfit, path.basename(linkedReal)));
  fs.symlinkSync(tree2, path.join(tmp, "tree2-link"));
  const settle = (key, runId, result) => ({ type: "settle", key, runId, fingerprint: "f", at: "t", result });
  fs.writeFileSync(
    path.join(pfit, "children.jsonl"),
    [
      settle("intake", "intake-run", {
        status: "done",
        loop: null,
        structuredOutput: {
          ok: true,
          tasks: [
            { id: "fit-a", est: 10000, bytes: 4000 },
            { id: "fit-b", est: 19000 },
            { id: "fit-c", est: 22000, sizing: { base: 6000, k_read: 2, growth_p90: 12000 } },
            { id: "fit-d", est: 12345 },
          ],
        },
      }),
      settle("impl-fit-a", "impl-a-run", { status: "done", loop: null, usage: { firstContext: 13000, peakContext: 14000 } }),
      settle("impl-fit-b", "impl-b-run", { status: "done", loop: null, usage: { firstContext: 11000, peakContext: 11500 } }),
      settle("impl-fit-c", "impl-c-run", { status: "done", loop: null, usage: { firstContext: 12000, peakContext: 12500 } }),
      settle("integrate", "integrate-run", { status: "done", loop: null, usage: { firstContext: 8000, peakContext: 8000 } }),
      settle("resolve-x", "resolve-run", { status: "done", loop: null, usage: { firstContext: 8000, peakContext: 8000 } }),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const r = run([path.join(tmp, "sessions"), path.join(tmp, "tree2-link"), "--min-samples", "2"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.roles.locator, {
    samples: 3,
    base: 7000,
    peak_p90: 20000,
    compact_rate: 0,
    cold_per_run: 0,
    growth_p90: 13000,
  });
  assert.deepEqual(r.json.roles.implementer, {
    samples: 25,
    base: 7000,
    peak_p90: 17000,
    compact_rate: 0,
    cold_per_run: 0,
    k_read: 2.67,
    growth_p90: 3330,
  });
  assert.deepEqual(r.json.plan_fit, { pairs: 3, k_read: 2.67, growth_p90: 3330, covered: 3, coverage: 1 });
  assert.deepEqual(r.json.excluded, { implementer: 2 });
  assert.deepEqual(r.json.looped, { extractor: 1 });
}

// A loop of links ends where the real directories run out; a root that is
// only links resolves nowhere and is an error.
{
  const loopA = path.join(tmp, "loop-a");
  fs.mkdirSync(loopA, { recursive: true });
  fs.symlinkSync(loopA, path.join(loopA, "self"));
  const r = run([loopA]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.roles, {});
  assert.deepEqual(r.json.plan_fit, { pairs: 0 });
  const cycleX = path.join(tmp, "cycle-x");
  fs.mkdirSync(cycleX, { recursive: true });
  fs.symlinkSync(path.join(cycleX, "b"), path.join(cycleX, "a"));
  fs.symlinkSync(path.join(cycleX, "a"), path.join(cycleX, "b"));
  assert.equal(run([path.join(cycleX, "a")]).status, 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-sizing: all assertions passed");
