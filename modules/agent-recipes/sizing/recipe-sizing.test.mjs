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
const transcript = (role, records, extra = "") => {
  const id = `00000000-0000-0000-0000-${String(counter++).padStart(12, "0")}`;
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n" + extra;
  fs.writeFileSync(path.join(sessions, `${id}_${role}_transcript.jsonl`), body);
};

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

const sizing = (...args) => {
  const r = spawnSync(process.execPath, [script, path.join(tmp, "sessions"), ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

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
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-sizing: all assertions passed");
