/**
 * Dry run of the plan workflow script against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (child order, briefs,
 * gate commands, revisions, review, retry, receipt); pi-subagents' semantics
 * are not exercised, and the gate results are the fake's, not a real plan.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./workflow.js", import.meta.url), "utf8");
assert.ok(!/\basync\b/.test(source), "workflow scripts may not define async functions");
assert.ok(!/setTimeout/.test(source), "the sandbox has no setTimeout");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = (runs, args) => new AsyncFunction("runs", "args", source)(runs, Object.freeze(args));

const ok = (key, structuredOutput) => ({ ok: true, runId: `run-${key}`, structuredOutput });
const failed = (key, error) => ({ ok: false, runId: `run-${key}`, error });

const good = {
  ok: true,
  tasks: [
    { id: "t1", est: 5000 },
    { id: "t2", est: 6000 },
  ],
  oversize: [],
  overlaps: [],
  missing: [],
  cycles: [],
};
const bad = {
  ok: false,
  tasks: [{ id: "t1", est: 150000 }],
  oversize: ["t1"],
  overlaps: [["t1", "t2", "a.nix"]],
  missing: ["t2: check"],
  cycles: [["t1", "t2", "t1"]],
};
const taskless = { ok: false, tasks: [], oversize: [], overlaps: [], missing: ["no tasks"], cycles: [] };
const clean = { ok: true, asked: "yes", sound: "yes", clean: true, verdict: "clean" };
const needsWork = { ok: true, asked: "partly", sound: "yes", clean: false, verdict: "needs-work" };

// `planner` and `reviewer` map a child key to its result; an unlisted key
// gets `good` and `clean`; a string is a failure message.
function fake({ planner = {}, reviewer = {}, scout = {} } = {}) {
  const batches = [];
  const answer = (table, key, fallback) => {
    const given = key in table ? table[key] : fallback;
    return typeof given === "string" ? failed(key, given) : ok(key, given);
  };
  return {
    batches,
    items: () => batches.flat(),
    runs: {
      all: async (items) => {
        batches.push(items);
        return items.map((item) => {
          switch (item.agent) {
            case "scout":
              return answer(scout, item.key, undefined);
            case "planner":
              return answer(planner, item.key, good);
            case "reviewer":
              return answer(reviewer, item.key, clean);
          }
          throw new Error(`unexpected agent ${item.agent}`);
        });
      },
    },
  };
}

const keys = (f) => f.batches.map((b) => b.map((i) => i.key));
const byKey = (f) => Object.fromEntries(f.items().map((i) => [i.key, i]));
const base = { dir: "/t/d", goal: "The goal.", input: "/t/in.md", repo: "/r" };

function assertUniqueOutputs(f) {
  const outputs = f.items().map((i) => i.output).filter(Boolean);
  assert.equal(new Set(outputs).size, outputs.length, "two children share an output path");
}

// A clean plan: scout, planner, review, receipt.
{
  const f = fake();
  const receipt = await run(f.runs, { ...base, limit: 80000, sizing: "/s.json" });
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"]]);
  const k = byKey(f);

  assert.equal(k.scout.agent, "scout");
  assert.equal(k.scout.output, "/t/d/scout.md");
  assert.match(k.scout.task, /Goal: The goal\./);
  assert.match(k.scout.task, /Input: \/t\/in\.md \(read it first\)/);
  assert.match(k.scout.task, /Repository: \/r/);

  assert.equal(k.plan.agent, "planner");
  assert.equal(k.plan.output, "/t/d/planner.md");
  assert.equal(k.plan.outputMode, "file-only");
  assert.deepEqual(k.plan.gate, { command: "recipe-gate plan '/t/d' --repo '/r' --limit 80000 --sizing '/s.json'", output: "json" });
  assert.match(k.plan.task, /^Job: implementation plan\.$/m);
  assert.match(k.plan.task, /Input: \/t\/in\.md\nRepository: \/r\nScout notes: \/t\/d\/scout\.md\nPlan directory: \/t\/d/);
  assert.match(k.plan.task, /Write \/t\/d\/plan\.md and one \/t\/d\/tasks\/<id>\.md per task/);

  assert.equal(k.review.agent, "reviewer");
  assert.equal(k.review.output, "/t/d/review.md");
  assert.equal(k.review.gate.command, "recipe-gate verdict '/t/d/review.md'");
  assert.match(k.review.task, /Review an implementation plan \(the plan variant\)\./);
  assert.match(k.review.task, /Plan: \/t\/d\/plan\.md and \/t\/d\/tasks\//);
  assert.match(k.review.task, /Plan check to run: recipe-gate plan '\/t\/d' --repo '\/r' --limit 80000/);
  assertUniqueOutputs(f);

  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", open: [], children: 3 });
}

// The default gate command carries no limit and no sizing file.
{
  const f = fake();
  await run(f.runs, base);
  assert.equal(byKey(f).plan.gate.command, "recipe-gate plan '/t/d' --repo '/r'");
}

// A failing gate sends the findings back to the planner once; the revision
// passes, so the review follows.
{
  const f = fake({ planner: { plan: bad } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["revise-1"], ["review"]]);
  const rev = byKey(f)["revise-1"];
  assert.equal(rev.output, "/t/d/revision-1.md");
  assert.equal(rev.gate.command, byKey(f).plan.gate.command);
  assert.match(rev.task, /^Job: implementation plan \(revision 1\)\.$/m);
  assert.match(rev.task, /- oversize: t1 \(estimate 150000\): split it along its owned files/);
  assert.match(rev.task, /- overlap: t1 and t2 both own a\.nix: give the file to one task/);
  assert.match(rev.task, /- cycle: t1 > t2 > t1: break the loop/);
  assert.match(rev.task, /- missing: t2: check/);
  assert.match(rev.task, /Check output: \{"oversize":\["t1"\],"overlaps":\[\["t1","t2","a\.nix"\]\],"missing":\["t2: check"\],"cycles":\[\["t1","t2","t1"\]\]\}/);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", open: [], children: 4 });
}

// A plan that never passes gets two revisions, then the review, and the
// receipt records what is still wrong.
{
  const f = fake({ planner: { plan: bad, "revise-1": bad, "revise-2": bad } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["revise-1"], ["revise-2"], ["review"]]);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    plan_dir: "/t/d",
    tasks: 1,
    oversize: ["t1"],
    overlaps: [["t1", "t2", "a.nix"]],
    review: "clean",
    open: ["oversize: t1", "overlap: t1 and t2 both own a.nix", "cycle: t1 > t2 > t1", "missing: t2: check"],
    children: 5,
  });
}

// A plan with no tasks by design is not revised.
{
  const f = fake({ planner: { plan: taskless } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"]]);
  assert.deepEqual(receipt.open, ["missing: no tasks"]);
  assert.equal(receipt.tasks, 0);
}

// A review that needs work sends the planner back once, then a second review.
{
  const f = fake({ reviewer: { review: needsWork } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["revise-review"], ["review-2"]]);
  const k = byKey(f);
  assert.equal(k["revise-review"].output, "/t/d/revision-review.md");
  assert.match(k["revise-review"].task, /^Job: implementation plan \(revision after review\)\.$/m);
  assert.match(k["revise-review"].task, /review at \/t\/d\/review\.md/);
  assert.equal(k["review-2"].output, "/t/d/review.2.md");
  assert.equal(k["review-2"].gate.command, "recipe-gate verdict '/t/d/review.2.md'");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", open: [], children: 5 });
}

// A second review that still needs work is recorded, not looped.
{
  const f = fake({ reviewer: { review: needsWork, "review-2": needsWork } });
  const receipt = await run(f.runs, base);
  assert.equal(f.batches.length, 5);
  assert.equal(receipt.review, "needs-work");
  assert.deepEqual(receipt.open, ["review verdict needs-work; see /t/d/review.2.md"]);
}

// A revision after review that breaks the gate is not reviewed again.
{
  const f = fake({ reviewer: { review: needsWork }, planner: { "revise-review": bad } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["revise-review"]]);
  assert.equal(receipt.review, "needs-work");
  assert.deepEqual(receipt.open, [
    "review verdict needs-work; see /t/d/review.md",
    "oversize: t1",
    "overlap: t1 and t2 both own a.nix",
    "cycle: t1 > t2 > t1",
    "missing: t2: check",
  ]);
  assert.equal(receipt.tasks, 1);
}

// An unreadable verdict is recorded and not looped.
{
  const f = fake({ reviewer: { review: { ok: false, verdict: "invalid" } } });
  const receipt = await run(f.runs, base);
  assert.equal(f.batches.length, 3);
  assert.equal(receipt.review, "invalid");
  assert.deepEqual(receipt.open, ["review verdict invalid; see /t/d/review.md"]);
}

// A scout that fails twice leaves the planner without notes; the retry writes
// beside the failed child's file.
{
  const f = fake({ scout: { scout: "503", "scout-retry": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["scout-retry"], ["plan"], ["review"]]);
  assert.equal(f.batches[1][0].output, "/t/d/scout.retry.md");
  assert.match(byKey(f).plan.task, /Scout notes: none: the scout failed, so look up the facts yourself/);
  assert.match(byKey(f).review.task, /Scout notes: none: the scout failed/);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.open, ["scout failed: 503; the planner worked without notes"]);
  assert.equal(receipt.children, 4);
}

// A scout that fails once is retried and its retry file is the notes.
{
  const f = fake({ scout: { scout: "503" } });
  await run(f.runs, base);
  assert.match(byKey(f).plan.task, /Scout notes: \/t\/d\/scout\.retry\.md/);
}

// A planner that fails twice ends the run with no review.
{
  const f = fake({ planner: { plan: "boom", "plan-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["plan-retry"]]);
  assert.equal(f.batches[2][0].output, "/t/d/planner.retry.md");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    plan_dir: "/t/d",
    tasks: 0,
    oversize: [],
    overlaps: [],
    review: null,
    open: ["the planner failed: boom"],
    children: 3,
  });
}

// A revision that fails twice stops the revising; the review still runs.
{
  const f = fake({ planner: { plan: bad, "revise-1": "x", "revise-1-retry": "x" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["revise-1"], ["revise-1-retry"], ["review"]]);
  assert.equal(f.batches[3][0].output, "/t/d/revision-1.retry.md");
  assertUniqueOutputs(f);
  assert.equal(receipt.open[0], "revision 1 failed: x");
  assert.equal(receipt.open.length, 5);
  assert.equal(receipt.children, 5);
}

// A reviewer that fails twice leaves the verdict unknown.
{
  const f = fake({ reviewer: { review: "boom", "review-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["review-retry"]]);
  assert.equal(f.batches[3][0].output, "/t/d/review.retry.md");
  assert.equal(f.batches[3][0].gate.command, "recipe-gate verdict '/t/d/review.retry.md'");
  assert.equal(receipt.review, null);
  assert.deepEqual(receipt.open, ["the review failed or its gate did not run"]);
}

// Every output path is unique across the longest path through the graph.
{
  const f = fake({
    scout: { scout: "x" },
    planner: { plan: bad, "revise-1": bad, "revise-2": good, "revise-review": good },
    reviewer: { review: needsWork, "review-2": needsWork },
  });
  await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["scout-retry"], ["plan"], ["revise-1"], ["revise-2"], ["review"], ["revise-review"], ["review-2"]]);
  assertUniqueOutputs(f);
}

// A path with a quote is shell-escaped in the gate commands.
{
  const f = fake();
  await run(f.runs, { ...base, dir: "/tmp/it's", repo: "/r o" });
  assert.equal(byKey(f).plan.gate.command, "recipe-gate plan '/tmp/it'\\''s' --repo '/r o'");
  assert.equal(byKey(f).review.gate.command, "recipe-gate verdict '/tmp/it'\\''s/review.md'");
}

console.log("plan workflow: ok");
