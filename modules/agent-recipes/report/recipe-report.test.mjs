/**
 * Behaviour tests for recipe-report against a synthetic run tree. Run by
 * `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-report.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-report-"));

const start = (runId, role, key) => ({ type: "start", key, runId, role, harness: "pi" });
const settle = (key, runId, result) => ({ type: "settle", key, runId, at: "2026-01-01T00:00:00.000Z", result });
const usage = (prompt, cached, output, peak, compactions = 0) => ({
  prompt,
  cached,
  output,
  peakContext: peak,
  firstContext: peak - 1000,
  turns: 1,
  compactions,
});

// Run A: one looped child, a handoff followed by a relay record, two review
// rounds, a diagnosis and a retry; the children file ends with a line that
// does not parse.
const runA = path.join(tmp, "runs", "a");
fs.mkdirSync(path.join(runA, "runner"), { recursive: true });
fs.writeFileSync(
  path.join(runA, "runner", "status.json"),
  JSON.stringify({ recipe: "impl", harness: "pi", state: "done", startedAt: "2026-01-01T00:00:00.000Z", lastUpdate: "2026-01-01T00:10:30.000Z" }),
);
const a = [
  start("a1", "scout", "intake"),
  settle("intake", "a1", { status: "done", usage: usage(1000, 300, 50, 5000) }),
  start("a2", "implementer", "impl-x"),
  settle("impl-x", "a2", { status: "done", usage: usage(9000, 1000, 200, 60000, 1), loop: true }),
  start("a3", "reviewer", "review-gate-quotes-1"),
  settle("review-gate-quotes-1", "a3", { status: "done", usage: usage(2000, 500, 80, 30000), structuredOutput: { verdict: "needs-work" } }),
  start("a4", "reviewer", "review-gate-quotes-2"),
  settle("review-gate-quotes-2", "a4", { status: "done", usage: usage(3000, 800, 90, 40000), structuredOutput: { verdict: "clean" } }),
  start("a5", "implementer", "impl-y"),
  settle("impl-y", "a5", { status: "done", usage: usage(4000, 1200, 110, 20000), handoff: { line: "h" } }),
  { type: "handoff", key: "impl-y-2", runId: "a5", as: "relay", by: "a6" },
  start("a7", "scout", "diagnose-x"),
  settle("diagnose-x", "a7", { status: "done", usage: usage(600, 100, 20, 10000) }),
  start("a8", "implementer", "impl-x.retry"),
  settle("impl-x.retry", "a8", { status: "failed", usage: usage(500, 0, 10, 8000) }),
];
fs.writeFileSync(path.join(runA, "runner", "children.jsonl"), a.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
fs.writeFileSync(path.join(runA, "receipt.json"), JSON.stringify({ merged: ["m1", "m2"], set_aside: ["s1"], open: ["o1"] }));

// Run B: one review per task (clean, invalid) and a failed scout; also
// reachable through a symlink, so it must be counted once.
const runB = path.join(tmp, "runs", "b");
fs.mkdirSync(path.join(runB, "runner"), { recursive: true });
fs.writeFileSync(
  path.join(runB, "runner", "status.json"),
  JSON.stringify({ recipe: "research", harness: "claude", state: "running", startedAt: "2026-01-01T01:00:00.000Z", lastUpdate: "2026-01-01T01:05:00.000Z" }),
);
const b = [
  start("b1", "reviewer", "review-task-a-1"),
  settle("review-task-a-1", "b1", { status: "done", usage: usage(700, 200, 30, 12000), structuredOutput: { verdict: "clean" } }),
  start("b2", "reviewer", "review-task-b-1"),
  settle("review-task-b-1", "b2", { status: "done", usage: usage(800, 0, 40, 15000), structuredOutput: { verdict: "invalid" } }),
  start("b3", "scout", "pin"),
  settle("pin", "b3", { status: "failed", usage: usage(900, 400, 60, 9000) }),
];
fs.writeFileSync(path.join(runB, "runner", "children.jsonl"), b.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(runB, "receipt.json"), JSON.stringify({ merged: ["m1"], open: [] }));
fs.symlinkSync(fs.realpathSync(runB), path.join(tmp, "link"));

const run = (args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: args.includes("--json") && r.stdout ? JSON.parse(r.stdout) : null };
};
const line = (out, prefix) => out.split("\n").find((l) => l.startsWith(prefix));

// --json: every number, pooled over both runs; run B reached twice counts once.
{
  const r = run([tmp, "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.runs, [
    {
      path: fs.realpathSync(runA),
      recipe: "impl",
      harness: "pi",
      state: "done",
      minutes: 10.5,
      children: 7,
      prompt: 20100,
      cached: 3900,
      output: 560,
      cache_share: 0.16,
      receipt: { merged: 2, set_aside: 1, open: 1 },
    },
    {
      path: fs.realpathSync(runB),
      recipe: "research",
      harness: "claude",
      state: "running",
      minutes: 5,
      children: 3,
      prompt: 2400,
      cached: 600,
      output: 130,
      cache_share: 0.2,
      receipt: { merged: 1, open: 0 },
    },
  ]);
  assert.deepEqual(r.json.roles, {
    implementer: { children: 3, statuses: { done: 2, failed: 1 }, handoffs: 1, relayed: 1, split: 0, loops: 1, compactions: 1, peak_median: 20000, peak_p90: 60000 },
    reviewer: { children: 4, statuses: { done: 4 }, handoffs: 0, relayed: 0, split: 0, loops: 0, compactions: 0, peak_median: 15000, peak_p90: 40000 },
    scout: { children: 3, statuses: { done: 2, failed: 1 }, handoffs: 0, relayed: 0, split: 0, loops: 0, compactions: 0, peak_median: 9000, peak_p90: 10000 },
  });
  assert.deepEqual(r.json.reviews, {
    by_verdict: { clean: 2, invalid: 1, "needs-work": 1 },
    tasks: {
      "gate-quotes": { first_clean: false, rounds: 2 },
      "task-a": { first_clean: true, rounds: 1 },
      "task-b": { first_clean: false, rounds: 1 },
    },
    first_clean: 1,
    first_clean_share: 0.33,
  });
  assert.deepEqual(r.json.diagnoses, { diagnoses: 1, retries: 1 });
}

// Text: the same numbers, in lines.
{
  const r = run([tmp]);
  assert.equal(r.status, 0);
  const aLine = line(r.stdout, fs.realpathSync(runA));
  assert.ok(aLine.includes("impl") && aLine.includes("pi") && aLine.includes("done") && aLine.includes("10.5") && aLine.includes("7"));
  assert.ok(aLine.includes("20100") && aLine.includes("3900") && aLine.includes("560") && aLine.includes("0.16"));
  assert.ok(aLine.includes("merged=2,open=1,set_aside=1"));
  const bLine = line(r.stdout, fs.realpathSync(runB));
  assert.ok(bLine.includes("research") && bLine.includes("claude") && bLine.includes("running"));
  assert.ok(bLine.includes("2400") && bLine.includes("600") && bLine.includes("130") && bLine.includes("0.2"));
  assert.ok(bLine.includes("merged=1,open=0"));
  assert.equal(r.stdout.split("\n").filter((l) => l.includes("20100") || l.includes("2400")).length, 2);
  const impl = line(r.stdout, "implementer");
  assert.ok(impl.includes("done=2,failed=1") && impl.includes("1") && impl.includes("20000") && impl.includes("60000"));
  const rev = line(r.stdout, "reviewer");
  assert.ok(rev.includes("done=4") && rev.includes("15000") && rev.includes("40000"));
  const scout = line(r.stdout, "scout");
  assert.ok(scout.includes("done=2,failed=1") && scout.includes("9000") && scout.includes("10000"));
  assert.ok(r.stdout.includes("by_verdict: clean=2,invalid=1,needs-work=1"));
  assert.ok(r.stdout.includes("gate-quotes: first_clean=no,rounds=2"));
  assert.ok(r.stdout.includes("task-a: first_clean=yes,rounds=1"));
  assert.ok(r.stdout.includes("task-b: first_clean=no,rounds=1"));
  assert.ok(r.stdout.includes("first_clean_share: 0.33"));
  assert.ok(r.stdout.includes("diagnoses: 1, retries: 1"));
}

// No arguments prints usage and exits 2.
{
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: recipe-report <run-dir>\.\.\. \[--json\]/);
}

// A directory with no runs prints an empty report and exits 0.
{
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty);
  const r = run([empty, "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.runs, []);
  assert.deepEqual(r.json.roles, {});
  assert.deepEqual(r.json.reviews, { by_verdict: {}, tasks: {}, first_clean: 0, first_clean_share: null });
  assert.deepEqual(r.json.diagnoses, { diagnoses: 0, retries: 0 });
  const t = run([empty]);
  assert.equal(t.status, 0);
  assert.ok(t.stdout.includes("runs:") && t.stdout.includes("roles:") && t.stdout.includes("reviews:"));
  assert.ok(t.stdout.includes("first_clean_share: -"));
  assert.ok(t.stdout.includes("diagnoses: 0, retries: 0"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-report: all assertions passed");
