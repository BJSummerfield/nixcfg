/**
 * Dry run of the plan graph on the shared library against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (child order, briefs,
 * gate commands, revisions, research, review, retry, receipt); pi-subagents' semantics
 * are not exercised, and the gate results are the fake's, not a real plan.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const source =
  fs.readFileSync(new URL("../lib/recipe-lib.js", import.meta.url), "utf8") + "\n" + fs.readFileSync(new URL("./graph.js", import.meta.url), "utf8");
assert.ok(!/\basync\b/.test(source), "workflow scripts may not define async functions");
assert.ok(!/setTimeout/.test(source), "the sandbox has no setTimeout");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = (runs, args, emit) => new AsyncFunction("runs", "args", "emit", source)(runs, Object.freeze(args), emit);

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
const invalid = { ok: false, verdict: "invalid" };
const diagnosis = (action, reason, extra = {}) => ({ ok: true, action, reason, verdict: null, owns: [], brief: action === "fix" || action === "replan", ...extra });
const urlList = (urls) => ({ ok: urls.length > 0, urls });
const found = (task, n, kind = "primary") => ({ url: `https://example.com/${task}/${n}`, why: "w", kind });
const extractOk = { ok: true, bytes: 5000, quotes: 3, over_cap: false };
const extractOver = { ok: false, bytes: 30000, quotes: 5, over_cap: true };
const extractRejected = { ok: false, bytes: 10, quotes: 0, over_cap: false };
const decided = diagnosis("decide", "a person has to choose");

// `planner`, `reviewer` and `diagnose` map a child key to its result; an
// unlisted key gets `good`, `clean` and a diagnosis that asks a person; a
// string is a failure message.
function fake({ planner = {}, reviewer = {}, scout = {}, diagnose = {}, searcher = {}, extractor = {} } = {}) {
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
            case "searcher":
              return answer(searcher, item.key, urlList([]));
            case "extractor":
              return answer(extractor, item.key, extractOk);
            case "reviewer":
              return item.key.startsWith("diagnose-") ? answer(diagnose, item.key, decided) : answer(reviewer, item.key, clean);
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
  assert.ok(!("big" in k.scout), "the scout is small");
  assert.equal(k.plan.big, true);
  assert.equal(k.review.big, true);
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
  assert.match(k.plan.task, /When the file is written, run `recipe-gate plan '\/t\/d' --repo '\/r' --limit 80000 --sizing '\/s\.json'`; if it reports a problem/);
  assert.doesNotMatch(k.scout.task, /When the file is written/);
  assert.match(k.review.task, /When the file is written, run `recipe-gate verdict '\/t\/d\/review\.md'`/);
  assert.match(k.plan.task, /Write \/t\/d\/plan\.md and one \/t\/d\/tasks\/<id>\.md per task/);

  assert.equal(k.review.agent, "reviewer");
  assert.equal(k.review.output, "/t/d/review.md");
  assert.equal(k.review.gate.command, "recipe-gate verdict '/t/d/review.md'");
  assert.match(k.review.task, /Review an implementation plan \(the plan variant\)\./);
  assert.match(k.review.task, /Plan: \/t\/d\/plan\.md and \/t\/d\/tasks\//);
  assert.match(k.review.task, /Plan check to run: recipe-gate plan '\/t\/d' --repo '\/r' --limit 80000/);
  assertUniqueOutputs(f);

  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", research: {}, healed: [], decide: [], open: [], children: 3 });
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
  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", research: {}, healed: [], decide: [], open: [], children: 4 });
}

// A plan that never passes gets two revisions, then a diagnosis; one that asks
// a person leaves the plan as it is, and the review still runs.
{
  const f = fake({ planner: { plan: bad, "revise-1": bad, "revise-2": bad } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["revise-1"], ["revise-2"], ["diagnose-1"], ["review"]]);
  const d = byKey(f)["diagnose-1"];
  assert.equal(d.agent, "reviewer");
  assert.equal(d.output, "/t/d/diagnosis-1.md");
  assert.equal(d.gate.command, "recipe-gate diagnosis '/t/d/diagnosis-1.md' --allow 'fix,decide'");
  assert.match(d.task, /^Diagnose a step whose output the script did not accept \(the diagnosis variant\)\.$/m);
  assert.match(d.task, /What went wrong: the plan check still fails after 2 revisions: oversize: t1; overlap: t1 and t2 both own a\.nix/);
  assert.match(d.task, /Evidence: \/t\/d\/plan\.md, \/t\/d\/revision-2\.md/);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    plan_dir: "/t/d",
    tasks: 1,
    oversize: ["t1"],
    overlaps: [["t1", "t2", "a.nix"]],
    review: "clean",
    research: {},
    healed: [],
    decide: [{ id: null, step: "plan", question: "a person has to choose", diagnosis: "/t/d/diagnosis-1.md" }],
    open: ["oversize: t1", "overlap: t1 and t2 both own a.nix", "cycle: t1 > t2 > t1", "missing: t2: check"],
    children: 6,
  });
}

// A diagnosis can give the planner one more revision with its brief.
{
  const f = fake({
    planner: { plan: bad, "revise-1": bad, "revise-2": bad },
    diagnose: { "diagnose-1": diagnosis("fix", "t1 bundles two modules; split by module") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["revise-1"], ["revise-2"], ["diagnose-1"], ["revise-3"], ["review"]]);
  const rev = byKey(f)["revise-3"];
  assert.match(rev.task, /^Job: implementation plan \(revision 3, from a diagnosis\)\.$/m);
  assert.match(rev.task, /The diagnosis at \/t\/d\/diagnosis-1\.md found: t1 bundles two modules; split by module Follow its ## Brief section\./);
  assert.match(rev.task, /- oversize: t1/);
  assert.deepEqual(receipt.open, []);
  assert.deepEqual(receipt.healed, [{ id: null, step: "plan", action: "fix", reason: "t1 bundles two modules; split by module" }]);
}

// A plan with no tasks by design is not revised or diagnosed.
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
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["revise-1"], ["review-2"]]);
  const k = byKey(f);
  assert.equal(k["revise-1"].output, "/t/d/revision-1.md");
  assert.match(k["revise-1"].task, /^Job: implementation plan \(revision 1 after review\)\.$/m);
  assert.match(k["revise-1"].task, /review at \/t\/d\/review\.md/);
  assert.equal(k["review-2"].output, "/t/d/review.2.md");
  assert.equal(k["review-2"].gate.command, "recipe-gate verdict '/t/d/review.2.md'");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, { plan_dir: "/t/d", tasks: 2, oversize: [], overlaps: [], review: "clean", research: {}, healed: [], decide: [], open: [], children: 5 });
}

// A second review that still needs work goes to a diagnosis; a fix gets one
// more revision and a third review.
{
  const f = fake({
    reviewer: { review: needsWork, "review-2": needsWork },
    diagnose: { "diagnose-1": diagnosis("fix", "the check for t2 only prints") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["revise-1"], ["review-2"], ["diagnose-1"], ["revise-2"], ["review-3"]]);
  assert.match(byKey(f)["diagnose-1"].task, /Evidence: \/t\/d\/review\.2\.md, \/t\/d\/plan\.md/);
  assert.match(byKey(f)["revise-2"].task, /The latest review is \/t\/d\/review\.2\.md\./);
  assert.equal(byKey(f)["review-3"].output, "/t/d/review.3.md");
  assertUniqueOutputs(f);
  assert.equal(receipt.review, "clean");
  assert.deepEqual(receipt.open, []);
}

// One that asks a person is recorded, not looped.
{
  const f = fake({ reviewer: { review: needsWork, "review-2": needsWork } });
  const receipt = await run(f.runs, base);
  assert.equal(f.batches.length, 6);
  assert.equal(receipt.review, "needs-work");
  assert.deepEqual(receipt.open, ["review verdict needs-work; see /t/d/review.2.md"]);
  assert.equal(receipt.decide.length, 1);
}

// A revision after review that breaks the gate is not reviewed again.
{
  const f = fake({ reviewer: { review: needsWork }, planner: { "revise-1": bad } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["revise-1"]]);
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

// An unreadable verdict goes to a diagnosis, which reads it.
{
  const f = fake({
    reviewer: { review: invalid },
    diagnose: { "diagnose-1": diagnosis("continue", "the verdict is under a title", { verdict: "clean" }) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["diagnose-1"]]);
  assert.equal(byKey(f)["diagnose-1"].gate.command, "recipe-gate diagnosis '/t/d/diagnosis-1.md' --allow 'continue,retry,decide' --verdict yes");
  assert.equal(receipt.review, "clean");
  assert.deepEqual(receipt.open, []);

  const g = fake({ reviewer: { review: invalid } });
  const asked = await run(g.runs, base);
  assert.equal(asked.review, null);
  assert.deepEqual(asked.open, ["no review verdict; see /t/d/review.md"]);
  assert.equal(asked.decide[0].step, "review");
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

// A planner that fails twice goes to a diagnosis; one that asks a person ends
// the run with no review, one that says retry runs the planner once more.
{
  const f = fake({ planner: { plan: "boom", "plan-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["plan-retry"], ["diagnose-1"]]);
  assert.equal(f.batches[2][0].output, "/t/d/planner.retry.md");
  assert.match(byKey(f)["diagnose-1"].gate.command, / --allow 'retry,decide'$/);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    plan_dir: "/t/d",
    tasks: 0,
    oversize: [],
    overlaps: [],
    review: null,
    research: {},
    healed: [],
    decide: [{ id: null, step: "plan", question: "a person has to choose", diagnosis: "/t/d/diagnosis-1.md" }],
    open: ["the planner failed: boom"],
    children: 4,
  });

  const g = fake({ planner: { plan: "boom", "plan-retry": "boom" }, diagnose: { "diagnose-1": diagnosis("retry", "the engine restarted") } });
  const again = await run(g.runs, base);
  assert.deepEqual(keys(g), [["scout"], ["plan"], ["plan-retry"], ["diagnose-1"], ["plan-2"], ["review"]]);
  assert.equal(byKey(g)["plan-2"].output, "/t/d/planner-2.md");
  assert.match(byKey(g)["plan-2"].task, /An earlier attempt did not finish\. The diagnosis at \/t\/d\/diagnosis-1\.md found: the engine restarted/);
  assert.equal(again.review, "clean");
  assert.deepEqual(again.open, []);
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

// A reviewer that fails twice goes to a diagnosis; retry reviews again.
{
  const f = fake({
    reviewer: { review: "boom", "review-retry": "boom" },
    diagnose: { "diagnose-1": diagnosis("retry", "an engine error") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["review-retry"], ["diagnose-1"], ["review-2"]]);
  assert.equal(f.batches[3][0].output, "/t/d/review.retry.md");
  assert.equal(f.batches[3][0].gate.command, "recipe-gate verdict '/t/d/review.retry.md'");
  assert.equal(receipt.review, "clean");
}

// Healing stops after two diagnoses and the same diagnosis twice asks a person.
{
  const f = fake({
    reviewer: { review: invalid, "review-2": invalid, "review-3": invalid },
    diagnose: { "diagnose-1": diagnosis("retry", "flaky"), "diagnose-2": diagnosis("retry", "Flaky!") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["review"], ["diagnose-1"], ["review-2"], ["diagnose-2"]]);
  assert.match(receipt.decide[0].question, /the same diagnosis came back twice: Flaky!$/);

  const g = fake({
    reviewer: { review: invalid, "review-2": invalid, "review-3": invalid },
    diagnose: { "diagnose-1": diagnosis("retry", "one"), "diagnose-2": diagnosis("retry", "two") },
  });
  const capped = await run(g.runs, base);
  assert.deepEqual(keys(g), [["scout"], ["plan"], ["review"], ["diagnose-1"], ["review-2"], ["diagnose-2"], ["review-3"]]);
  assert.match(capped.decide[0].question, /still failing after 2 recoveries\)$/);
}

// Every output path is unique across the longest path through the graph.
{
  const f = fake({
    scout: { scout: "x" },
    planner: { plan: bad, "revise-1": bad, "revise-2": bad, "revise-3": good, "revise-4": good },
    reviewer: { review: needsWork, "review-2": needsWork },
    diagnose: { "diagnose-1": diagnosis("fix", "split t1"), "diagnose-2": diagnosis("fix", "the t2 check prints") },
  });
  await run(f.runs, base);
  assert.deepEqual(keys(f), [
    ["scout"], ["scout-retry"], ["plan"], ["revise-1"], ["revise-2"], ["diagnose-1"], ["revise-3"], ["review"], ["revise-4"], ["review-2"], ["diagnose-2"], ["revise-5"], ["review-3"],
  ]);
  assertUniqueOutputs(f);
}

// The board is emitted at each stage and ends with the receipt.
{
  const emits = [];
  const f = fake({ reviewer: { review: needsWork } });
  await run(f.runs, base, (value) => emits.push(JSON.parse(JSON.stringify(value))));
  assert.deepEqual(
    emits.map((e) => e.stage),
    ["planning", "reviewing", "revising", "reviewing", "finished"],
  );
  assert.deepEqual(emits.at(-1), {
    stage: "finished",
    plan_dir: "/t/d",
    tasks: 2,
    oversize: [],
    overlaps: [],
    review: "clean",
    research: {},
    open: [],
    children: 5,
    healed: [],
    decide: [],
  });
  assert.equal(emits[0].plan_ok, null);
  assert.equal(emits[1].plan_ok, true);
}

// Tasks that ask a research question get one search each, at most three
// extracts each, written under research/<id>/; the receipt counts the extracts
// that passed and an unproductive task is an open line.
{
  const asking = {
    ok: true,
    tasks: [
      { id: "t1", est: 5000, research: "How does x 2.0 set the cache dir?" },
      { id: "t2", est: 6000, research: "" },
      { id: "t3", est: 6000, research: "Does y 3.1 accept a timeout?" },
      { id: "t4", est: 6000, research: "What does z 9 return?" },
    ],
    oversize: [],
    overlaps: [],
    missing: [],
    cycles: [],
  };
  const f = fake({
    planner: { plan: asking },
    searcher: {
      "search-t1": urlList([found("t1", 1), found("t1", 2, "secondary"), found("t1", 3), found("t1", 4), found("t1", 5)]),
      "search-t3": urlList([found("t3", 1)]),
      "search-t4": "503",
      "search-t4-retry": "503",
    },
    extractor: { "extract-t1-2": extractOver, "extract-t1-3": extractRejected, "extract-t3-1": extractOk },
  });
  const emits = [];
  const receipt = await run(f.runs, base, (value) => emits.push(value.stage));
  assert.deepEqual(keys(f), [
    ["scout"],
    ["plan"],
    ["search-t1", "search-t3", "search-t4"],
    ["search-t4-retry"],
    ["extract-t1-1", "extract-t1-2", "extract-t1-3", "extract-t3-1"],
    ["review"],
  ]);
  const k = byKey(f);
  assert.equal(k["search-t1"].agent, "searcher");
  assert.equal(k["search-t1"].output, "/t/d/research/t1/search.md");
  assert.match(k["search-t1"].task, /Question: How does x 2\.0 set the cache dir\?/);
  assert.equal(k["search-t1"].gate.command, "recipe-gate urls '/t/d/research/t1/search.md'");
  assert.equal(k["extract-t1-1"].agent, "extractor");
  assert.equal(k["extract-t1-1"].output, "/t/d/research/t1/extract-1.md");
  assert.match(k["extract-t1-1"].task, /URL: https:\/\/example\.com\/t1\/1\n/);
  assert.match(k["extract-t1-1"].task, /Page: \/t\/d\/research\/t1\/page-1\.md/);
  assert.equal(k["extract-t1-1"].gate.command, "recipe-gate extract '/t/d/research/t1/extract-1.md'");
  assert.equal(k["extract-t3-1"].output, "/t/d/research/t3/extract-1.md");
  assert.ok(!("extract-t1-4" in k), "at most three sources per task");
  assert.ok(!Object.keys(k).some((key) => key.includes("t2")), "a task with no question gets no research");
  assertUniqueOutputs(f);
  assert.ok(emits.indexOf("researching") > emits.indexOf("planning") && emits.indexOf("researching") < emits.indexOf("reviewing"));
  assert.deepEqual(receipt.research, { t1: 1, t3: 1, t4: 0 });
  assert.deepEqual(receipt.open, ["research for t4: nothing usable (503)"]);
  assert.deepEqual(receipt.healed, []);
  assert.deepEqual(receipt.decide, []);
  assert.equal(receipt.review, "clean");
  assert.equal(receipt.children, 11);
}

// A search that lists nothing is an open line and starts no extractor; a
// failing extractor is retried like any child and is never diagnosed.
{
  const asking = { ...good, tasks: [{ id: "t1", est: 5000, research: "q1?" }, { id: "t2", est: 5000, research: "q2?" }] };
  const f = fake({
    planner: { plan: asking },
    searcher: { "search-t2": urlList([found("t2", 1)]) },
    extractor: { "extract-t2-1": "boom", "extract-t2-1-retry": "boom" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["scout"], ["plan"], ["search-t1", "search-t2"], ["extract-t2-1"], ["extract-t2-1-retry"], ["review"]]);
  assert.deepEqual(receipt.research, { t1: 0, t2: 0 });
  assert.deepEqual(receipt.open, ["research for t1: nothing usable (no sources listed)", "research for t2: nothing usable"]);
  assert.deepEqual(receipt.decide, []);
}

// Research waits for a plan that passes its check, and a plan whose check
// never passes is not researched.
{
  const asking = { ...bad, tasks: [{ id: "t1", est: 150000, research: "q?" }] };
  const f = fake({ planner: { plan: asking, "revise-1": asking, "revise-2": asking } });
  const receipt = await run(f.runs, base);
  assert.ok(!f.items().some((i) => i.agent === "searcher"));
  assert.deepEqual(receipt.research, {});
}

// A path with a quote is shell-escaped in the gate commands.
{
  const f = fake();
  await run(f.runs, { ...base, dir: "/tmp/it's", repo: "/r o" });
  assert.equal(byKey(f).plan.gate.command, "recipe-gate plan '/tmp/it'\\''s' --repo '/r o'");
  assert.equal(byKey(f).review.gate.command, "recipe-gate verdict '/tmp/it'\\''s/review.md'");
}

console.log("plan graph: ok");
