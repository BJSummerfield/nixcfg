/**
 * Dry run of the implement graph with the shared library against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (waves, briefs, gate
 * commands, review and fix rounds, set-aside and skipped tasks, retry,
 * integration, receipt); pi-subagents' semantics and the gates are not
 * exercised, and the gate results are the fake's.
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

const spec = (id, depends = [], research = undefined) => ({
  id,
  owns: [`${id}.nix`, `lib/${id}`],
  reads: [],
  check: `nixfmt --check ${id}.nix`,
  depends,
  ...(research ? { research } : {}),
  est: 1000,
});
const planOf = (tasks) => ({ ok: true, tasks, oversize: [], overlaps: [], missing: [], cycles: [] });
const badPlan = {
  ok: false,
  tasks: [],
  oversize: ["t1"],
  overlaps: [["t1", "t2", "a.nix"]],
  missing: ["t2: check"],
  cycles: [["t1", "t2", "t1"]],
};
const taskGate = (id) => ({
  ok: true,
  reason: "",
  report: { status: "done", why: "" },
  branch: `pi/${id}`,
  worktree: `/wt/${id}`,
  head: "h",
  base: `base-${id}`,
  clean: true,
  commits: 1,
  files: [`${id}.nix`],
  outside: [],
  check: { command: "c", exit: 0, tail: "" },
});
const clean = { ok: true, asked: "yes", sound: "yes", clean: true, verdict: "clean" };
const needsWork = { ok: true, asked: "partly", sound: "yes", clean: false, verdict: "needs-work" };
const diagnosis = (action, reason, extra = {}) => ({ ok: true, action, reason, verdict: null, owns: [], brief: action === "fix" || action === "replan", ...extra });
const decided = diagnosis("decide", "a person has to choose");

// Each table maps a child key to its result; an unlisted key gets the default
// (a good plan, a good task, a clean verdict, a successful fix, a successful
// integration, a diagnosis that asks a person); a string is a failure message.
function fake({ plan = planOf([spec("a")]), intake = {}, impl = {}, review = {}, fix = {}, integrate = {}, diagnose = {} } = {}) {
  const batches = [];
  const answer = (table, key, fallback) => {
    const given = key in table ? table[key] : fallback;
    if (given && given.result) return { runId: `run-${key}`, ...given.result };
    return typeof given === "string" ? failed(key, given) : ok(key, given);
  };
  const idOf = (key) => key.replace(/^impl-/, "").replace(/-retry$/, "");
  const integrated = (item) => {
    const pairs = item.gate.command.match(/--tasks '([^']*)'/)[1].split(",");
    const branch = item.gate.command.match(/--branch '([^']*)'/)[1];
    return {
      ok: true,
      reasons: [],
      branch,
      head: "h",
      merged: pairs.map((p) => p.split(":")[0]),
      unmerged: [],
      clean: true,
      heavy_check: "pass",
      pr_text: "PR text",
    };
  };
  return {
    batches,
    items: () => batches.flat(),
    runs: {
      all: async (items) => {
        batches.push(items);
        return items.map((item) => {
          if (item.resume) return answer(fix, item.key, undefined);
          switch (item.agent) {
            case "scout":
              return answer(intake, item.key, plan);
            case "implementer":
              return item.key.startsWith("integrate")
                ? answer(integrate, item.key, integrated(item))
                : answer(impl, item.key, taskGate(idOf(item.key)));
            case "reviewer":
              return item.key.startsWith("diagnose-") ? answer(diagnose, item.key, decided) : answer(review, item.key, clean);
          }
          throw new Error(`unexpected agent ${item.agent}`);
        });
      },
    },
  };
}

const keys = (f) => f.batches.map((b) => b.map((i) => i.key));
const byKey = (f) => Object.fromEntries(f.items().map((i) => [i.key, i]));
const base = { plan: "/t/p", repo: "/r" };

function assertUniqueOutputs(f) {
  const outputs = f.items().map((i) => i.output).filter(Boolean);
  assert.equal(new Set(outputs).size, outputs.length, "two children share an output path");
}

// Two waves. a is clean first time; b needs one fix round; c never
// gets clean and is set aside after two; d depends on a and b and runs; e
// depends on c and is skipped.
{
  const plan = planOf([spec("a"), spec("b", [], "which flag order?"), spec("c"), spec("d", ["a", "b"]), spec("e", ["c"])]);
  const f = fake({
    plan,
    review: {
      "review-b-1": needsWork,
      "review-c-1": needsWork,
      "review-c-2": needsWork,
      "review-c-3": needsWork,
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [
    ["intake"],
    ["impl-a", "impl-b", "impl-c"],
    ["review-a-1", "review-b-1", "review-c-1"],
    ["fix-b-1", "fix-c-1"],
    ["review-b-2", "review-c-2"],
    ["fix-c-2"],
    ["review-c-3"],
    ["diagnose-c-1"],
    ["impl-d"],
    ["review-d-1"],
    ["integrate"],
  ]);
  const k = byKey(f);

  assert.equal(k.intake.agent, "scout");
  assert.equal(k.intake.output, "/t/p/intake.md");
  assert.deepEqual(k.intake.gate, { command: "recipe-gate plan '/t/p' --repo '/r'", output: "json" });
  assert.match(k.intake.task, /Check that \/t\/p\/plan\.md can be read/);

  assert.equal(k["impl-a"].agent, "implementer");
  assert.equal(k["impl-a"].worktree, true);
  assert.equal(k["impl-a"].output, "/t/p/impl-a.md");
  assert.equal(k["impl-a"].outputMode, "file-only");
  assert.deepEqual(k["impl-a"].gate, {
    command: "recipe-gate task '/t/p/impl-a.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r'",
    output: "json",
    timeoutMs: 900000,
  });
  assert.match(k["impl-a"].task, /Task file: \/t\/p\/tasks\/a\.md \(read it first\)/);
  assert.match(k["impl-a"].task, /Plan: \/t\/p\/plan\.md/);
  assert.match(k["impl-a"].task, /Write the report to \/t\/p\/impl-a\.md/);
  assert.doesNotMatch(k["impl-a"].task, /merge each/);
  assert.equal(k["impl-b"].model, undefined);
  assert.match(k["impl-b"].task, /^Research notes for this task answer: which flag order\?\. They are under \/t\/p\/research\/b\/; read them before the first edit\.$/m);
  assert.doesNotMatch(k["impl-a"].task, /Research notes/);
  assert.match(k["impl-a"].task, /run `recipe-gate task .*`; if it reports a problem, fix the file and run it again before you finish\./);
  assert.doesNotMatch(k.integrate.task, /if it reports a problem/);
  assert.match(k["impl-d"].task, /`git merge --no-ff --no-edit <branch>`: a \(branch pi\/a\), b \(branch pi\/b\)/);

  assert.equal(k["review-b-1"].agent, "reviewer");
  assert.equal(k["review-b-1"].output, "/t/p/review-b-1.md");
  assert.deepEqual(k["review-b-1"].gate, { command: "recipe-gate verdict '/t/p/review-b-1.md'", output: "json" });
  assert.match(k["review-b-1"].task, /^Review a diff on a branch \(the diff variant\)\.$/m);
  assert.match(k["review-b-1"].task, /Branch: pi\/b/);
  assert.match(k["review-b-1"].task, /Worktree: \/wt\/b/);
  assert.match(k["review-b-1"].task, /Diff to review: git diff base-b\.\.\.pi\/b/);
  assert.match(k["review-b-1"].task, /Check to run: nixfmt --check b\.nix/);
  assert.match(k["review-b-1"].task, /Implementer report: \/t\/p\/impl-b\.md/);
  assert.doesNotMatch(k["review-b-1"].task, /Earlier review/);
  assert.match(k["review-b-2"].task, /re-review after fix round 1\./);
  assert.match(k["review-b-2"].task, /Earlier review: \/t\/p\/review-b-1\.md/);

  assert.equal(k["fix-b-1"].resume, "run-impl-b");
  assert.equal(k["fix-b-1"].agent, undefined);
  assert.equal(k["fix-b-1"].gate, undefined);
  assert.equal(k["fix-b-1"].output, "/t/p/fix-b-1.md");
  assert.match(k["fix-b-1"].task, /^Fix round 1 of 2\.$/m);
  assert.match(k["fix-b-1"].task, /worktree \/wt\/b on branch pi\/b/);
  assert.match(k["fix-b-1"].task, /The review at \/t\/p\/review-b-1\.md found blocking problems\./);
  assert.equal(k["fix-c-1"].resume, "run-impl-c");
  assert.equal(k["fix-c-2"].resume, "run-fix-c-1");
  assert.match(k["fix-c-2"].task, /^Fix round 2 of 2\.$/m);

  assert.equal(k.integrate.agent, "implementer");
  assert.equal(k.integrate.worktree, false);
  assert.equal(k.integrate.output, "/t/p/integration.md");
  assert.deepEqual(k.integrate.gate, {
    command: "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,d:pi/d' --branch 'implement/p' --tidy yes",
    output: "json",
  });
  assert.match(k.integrate.task, /Finished tasks, as id:branch: a:pi\/a,b:pi\/b,d:pi\/d/);
  assert.match(k.integrate.task, /worktree add -b implement\/p \/t\/p\/integration HEAD/);
  assert.match(k.integrate.task, /Write \/t\/p\/heavy\.md/);
  assert.match(k.integrate.task, /Write the pull request title and body to \/t\/p\/pr\.md/);
  assert.match(k.integrate.task, /Never merge into main and never push/);
  assert.equal(k["diagnose-c-1"].agent, "reviewer");
  assert.equal(k["diagnose-c-1"].output, "/t/p/diagnosis-c-1.md");
  assert.deepEqual(k["diagnose-c-1"].gate, {
    command: "recipe-gate diagnosis '/t/p/diagnosis-c-1.md' --allow 'fix,replan,decide'",
    output: "json",
  });
  assert.match(k["diagnose-c-1"].task, /^Diagnose a step whose output the script did not accept \(the diagnosis variant\)\.$/m);
  assert.match(k["diagnose-c-1"].task, /What went wrong: still not clean after 2 fix rounds: The review at \/t\/p\/review-c-3\.md/);
  assert.match(k["diagnose-c-1"].task, /Evidence: \/t\/p\/review-c-3\.md, \/t\/p\/impl-c\.md/);
  assert.match(k["diagnose-c-1"].task, /Worktree: \/wt\/c on branch pi\/c/);
  assert.match(k["diagnose-c-1"].task, /Allowed actions: fix, replan, decide/);
  assert.match(k["impl-a"].task, /write `blocked: <why>` as the first line of the report; do not ask/);
  assertUniqueOutputs(f);

  assert.deepEqual(receipt, {
    branch: "implement/p",
    merged: ["a", "b", "d"],
    set_aside: [{ id: "c", reason: "needs a decision: a person has to choose" }],
    skipped: ["e"],
    heavy_check: "pass",
    healed: [],
    decide: [{ id: "c", step: "review", question: "a person has to choose", diagnosis: "/t/p/diagnosis-c-1.md" }],
    open: [],
    children: 17,
    pr_text: "PR text",
  });
}

// A plan that is not ready is refused after the one child that runs the gate.
{
  const f = fake({ plan: badPlan });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"]]);
  assert.deepEqual(receipt, {
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    heavy_check: null,
    healed: [],
    decide: [],
    open: [
      "the plan is not ready to implement",
      "oversize: t1",
      "overlap: t1 and t2 both own a.nix",
      "cycle: t1 > t2 > t1",
      "missing: t2: check",
    ],
    children: 1,
    pr_text: "",
  });
}

// The plan gate carries the limit and the sizing file when given.
{
  const f = fake();
  await run(f.runs, { ...base, limit: 80000, sizing: "/s.json" });
  assert.equal(byKey(f).intake.gate.command, "recipe-gate plan '/t/p' --repo '/r' --limit 80000 --sizing '/s.json'");
}

// A plan gate child that fails twice ends the run; one that fails once is retried
// and the retry writes beside the first file.
{
  const f = fake({ intake: { intake: "503", "intake-retry": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["intake-retry"]]);
  assert.equal(f.batches[1][0].output, "/t/p/intake.retry.md");
  assert.deepEqual(receipt.open, ["the plan check did not run: 503"]);
  assert.equal(receipt.children, 2);
  assert.equal(receipt.branch, null);

  const g = fake({ intake: { intake: "503" } });
  const done = await run(g.runs, base);
  assert.deepEqual(keys(g), [["intake"], ["intake-retry"], ["impl-a"], ["review-a-1"], ["integrate"]]);
  assertUniqueOutputs(g);
  assert.deepEqual(done.merged, ["a"]);
  assert.equal(done.children, 5);
}

// A blocked task goes to a diagnosis, which asks a person; its dependent is
// skipped; with nothing finished there is no integration.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b", ["a"])]),
    impl: {
      "impl-a": {
        ...taskGate("a"),
        ok: false,
        reason: "report blocked: baseline failing",
        report: { status: "blocked", why: "baseline failing" },
      },
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["diagnose-a-1"]]);
  assert.match(byKey(f)["diagnose-a-1"].gate.command, / --allow 'replan,decide'$/);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the implementer reported blocked: report blocked: baseline failing/);
  assert.deepEqual(receipt, {
    branch: null,
    merged: [],
    set_aside: [{ id: "a", reason: "needs a decision: a person has to choose" }],
    skipped: ["b"],
    heavy_check: null,
    healed: [],
    decide: [{ id: "a", step: "implement", question: "a person has to choose", diagnosis: "/t/p/diagnosis-a-1.md" }],
    open: ["no task finished, so there is nothing to integrate"],
    children: 3,
    pr_text: "",
  });
}

// A task whose own check is red goes straight to a fix round, then a review.
{
  const f = fake({
    impl: { "impl-a": { ...taskGate("a"), ok: false, reason: "check failed (exit 1): red" } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["fix-a-1"], ["review-a-1"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["fix-a-1"].resume, "run-impl-a");
  assert.match(k["fix-a-1"].task, /The task check reported: check failed \(exit 1\): red/);
  assert.doesNotMatch(k["review-a-1"].task, /re-review/);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.children, 5);
}

// An implementer that fails twice goes to a diagnosis; the other task goes on
// and the retry writes beside the first report with its own gate path.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    impl: { "impl-a": "boom", "impl-a-retry": "boom" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a", "impl-b"], ["impl-a-retry"], ["review-b-1"], ["diagnose-a-1"], ["integrate"]]);
  const retry = f.batches[2][0];
  assert.equal(retry.output, "/t/p/impl-a.retry.md");
  assert.match(retry.task, /Write the report to \/t\/p\/impl-a\.retry\.md/);
  assert.equal(
    retry.gate.command,
    "recipe-gate task '/t/p/impl-a.retry.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r'",
  );
  assert.equal(retry.worktree, true);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the implementer failed twice: boom/);
  assert.deepEqual(receipt.merged, ["b"]);
  assert.equal(receipt.children, 7);
}

// An implementer that fails once and then succeeds is reviewed from its retry.
{
  const f = fake({ impl: { "impl-a": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["impl-a-retry"], ["review-a-1"], ["integrate"]]);
  assert.match(byKey(f)["review-a-1"].task, /Implementer report: \/t\/p\/impl-a\.retry\.md/);
  assert.deepEqual(receipt.set_aside, []);
}

// A fix that fails twice goes to a diagnosis; the retry resumes the failed run.
{
  const f = fake({
    review: { "review-a-1": needsWork },
    fix: { "fix-a-1": "x", "fix-a-1-retry": "x" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["fix-a-1-retry"], ["diagnose-a-1"]]);
  assert.equal(f.batches[4][0].resume, "run-fix-a-1");
  assert.equal(f.batches[4][0].output, "/t/p/fix-a-1.retry.md");
  assertUniqueOutputs(f);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: fix round 1 failed twice: x/);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
  assert.equal(receipt.children, 6);
}

// A reviewer that fails twice goes to a diagnosis that may retry it.
{
  const f = fake({ review: { "review-a-1": "boom", "review-a-1-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["review-a-1-retry"], ["diagnose-a-1"]]);
  assert.equal(f.batches[3][0].gate.command, "recipe-gate verdict '/t/p/review-a-1.retry.md'");
  assert.match(byKey(f)["diagnose-a-1"].gate.command, / --allow 'retry,decide'$/);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
}

// A verdict that cannot be read goes to a diagnosis, which reads it: clean
// merges, needs-work goes to a fix round.
{
  const f = fake({
    review: { "review-a-1": { ok: false, verdict: "invalid" } },
    diagnose: { "diagnose-a-1": diagnosis("continue", "the verdict is under a heading", { verdict: "clean" }) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["diagnose-a-1"], ["integrate"]]);
  assert.equal(
    byKey(f)["diagnose-a-1"].gate.command,
    "recipe-gate diagnosis '/t/p/diagnosis-a-1.md' --allow 'continue,retry,decide' --verdict yes",
  );
  assert.match(byKey(f)["diagnose-a-1"].task, /With continue, give the verdict the review states\./);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.healed, [{ id: "a", step: "review", action: "continue", reason: "the verdict is under a heading" }]);

  const g = fake({
    review: { "review-a-1": { ok: false, verdict: "invalid" } },
    diagnose: { "diagnose-a-1": diagnosis("continue", "it says partly", { verdict: "needs-work" }) },
  });
  const again = await run(g.runs, base);
  assert.deepEqual(keys(g), [["intake"], ["impl-a"], ["review-a-1"], ["diagnose-a-1"], ["fix-a-1"], ["review-a-2"], ["integrate"]]);
  assert.match(byKey(g)["fix-a-1"].task, /The review at \/t\/p\/review-a-1\.md found blocking problems\./);
  assert.deepEqual(again.merged, ["a"]);
}

// A blocked task is replanned: a fresh implementer gets the revised brief and
// a file owned by a task it builds on, then the normal review.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b", ["a"])]),
    impl: { "impl-b": { ...taskGate("b"), ok: false, reason: "report blocked: needs a.nix", report: { status: "blocked", why: "needs a.nix" } } },
    diagnose: { "diagnose-b-1": diagnosis("replan", "the test stubs live in a.nix", { owns: ["a.nix"] }) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["impl-b"], ["diagnose-b-1"], ["impl-b-2"], ["review-b-1"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-b-2"].output, "/t/p/impl-b-2.md");
  assert.equal(k["impl-b-2"].worktree, true);
  assert.match(k["impl-b-2"].gate.command, / --owns 'b\.nix,lib\/b,a\.nix' /);
  assert.match(k["impl-b-2"].task, /This is attempt 2\. .*the diagnosis at \/t\/p\/diagnosis-b-1\.md says why, and its ## Brief section is the revised task/);
  assert.match(k["impl-b-2"].task, /Besides the task's own files you may change: a\.nix/);
  assert.match(k["impl-b-2"].task, /: a \(branch pi\/a\)$/m);
  assert.match(k["review-b-1"].task, /Owned files: b\.nix, lib\/b, a\.nix/);
  assert.match(k["review-b-1"].task, /Revised task \(wins over the task file\): the ## Brief section of \/t\/p\/diagnosis-b-1\.md/);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.merged, ["a", "b"]);
  assert.deepEqual(receipt.healed, [{ id: "b", step: "implement", action: "replan", reason: "the test stubs live in a.nix" }]);
  assert.deepEqual(receipt.decide, []);
}

// A replan that needs a file owned by a task it does not build on goes to a person.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    impl: { "impl-b": { ...taskGate("b"), ok: false, reason: "report blocked: needs a.nix", report: { status: "blocked", why: "needs a.nix" } } },
    diagnose: { "diagnose-b-1": diagnosis("replan", "needs a.nix", { owns: ["lib/a/x.nix"] }) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.decide, [
    { id: "b", step: "implement", question: "the revised task needs lib/a/x.nix, which task a owns and this task does not build on", diagnosis: "/t/p/diagnosis-b-1.md" },
  ]);
  assert.deepEqual(receipt.merged, ["a"]);
}

// Still not clean after two fix rounds: a diagnosis can grant one more round.
{
  const f = fake({
    review: { "review-a-1": needsWork, "review-a-2": needsWork, "review-a-3": needsWork },
    diagnose: { "diagnose-a-1": diagnosis("fix", "the test asserts the old flag order") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [
    ["intake"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["review-a-2"], ["fix-a-2"], ["review-a-3"], ["diagnose-a-1"], ["fix-a-3"], ["review-a-4"], ["integrate"],
  ]);
  const k = byKey(f);
  assert.match(k["fix-a-3"].task, /^Extra fix round 3, from a diagnosis\.$/m);
  assert.match(k["fix-a-3"].task, /The diagnosis at \/t\/p\/diagnosis-a-1\.md found: the test asserts the old flag order Follow its ## Brief section\./);
  assert.equal(k["fix-a-3"].resume, "run-fix-a-2");
  assert.deepEqual(receipt.merged, ["a"]);
}

// The same diagnosis twice goes to a person instead of looping.
{
  const f = fake({
    impl: {
      "impl-a": { ...taskGate("a"), ok: false, reason: "blocked: x", report: { status: "blocked", why: "x" } },
      "impl-a-2": { ...taskGate("a"), ok: false, reason: "blocked: x", report: { status: "blocked", why: "x" } },
    },
    diagnose: {
      "diagnose-a-1": diagnosis("replan", "Split the change."),
      "diagnose-a-2": diagnosis("replan", "split the change"),
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["diagnose-a-1"], ["impl-a-2"], ["diagnose-a-2"]]);
  assert.equal(receipt.decide.length, 1);
  assert.match(receipt.decide[0].question, /the same diagnosis came back twice: split the change$/);
  assert.match(byKey(f)["diagnose-a-2"].task, /Earlier diagnosis: \/t\/p\/diagnosis-a-1\.md/);
}

// After two recoveries the next problem goes to a person without a third diagnosis.
{
  const blockedA = (id) => ({ ...taskGate(id), ok: false, reason: "blocked: " + id, report: { status: "blocked", why: id } });
  const f = fake({
    impl: { "impl-a": blockedA("a"), "impl-a-2": blockedA("a"), "impl-a-3": blockedA("a") },
    diagnose: { "diagnose-a-1": diagnosis("replan", "one"), "diagnose-a-2": diagnosis("replan", "two") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["diagnose-a-1"], ["impl-a-2"], ["diagnose-a-2"], ["impl-a-3"]]);
  assert.equal(receipt.healed.length, 2);
  assert.match(receipt.decide[0].question, /still failing after 2 recoveries\)$/);
  assert.equal(receipt.decide[0].diagnosis, "/t/p/diagnosis-a-2.md");
}

// A diagnosis the gate cannot read goes to a person.
{
  const f = fake({
    review: { "review-a-1": { ok: false, verdict: "invalid" } },
    diagnose: { "diagnose-a-1": { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false, problem: "no action line" } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.decide, [
    { id: "a", step: "review", question: "the review's verdict could not be read; the diagnosis could not be read: no action line", diagnosis: "/t/p/diagnosis-a-1.md" },
  ]);
}

// An integration the gate does not accept is diagnosed and run once more.
{
  const f = fake({
    integrate: { integrate: { ok: false, reasons: ["not merged: a"], branch: "implement/p", head: "h", merged: [], unmerged: ["a"], clean: true, heavy_check: "none", pr_text: "" } },
    diagnose: { "diagnose-integration-1": diagnosis("retry", "the merge stopped on a conflict it can resolve") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["integrate"], ["diagnose-integration-1"], ["integrate-2"]]);
  const k = byKey(f);
  assert.equal(k["integrate-2"].output, "/t/p/integration-2.md");
  assert.match(k["integrate-2"].task, /the diagnosis at \/t\/p\/diagnosis-integration-1\.md says why/);
  assert.equal(k["integrate-2"].gate.command, k.integrate.gate.command);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, []);
  assert.deepEqual(receipt.healed, [{ id: "integration", step: "integrate", action: "retry", reason: "the merge stopped on a conflict it can resolve" }]);
}

// The board is emitted after every round, from the accepted plan to the end.
{
  const emits = [];
  const f = fake({ plan: planOf([spec("a"), spec("b", ["a"])]), review: { "review-a-1": needsWork } });
  await run(f.runs, base, (value) => emits.push(JSON.parse(JSON.stringify(value))));
  assert.deepEqual(
    emits.map((e) => e.stage),
    ["plan accepted", "wave 1, round 1", "wave 1, round 2", "wave 2, round 1", "integrating", "finished"],
  );
  assert.deepEqual(emits[0].tasks, [
    { id: "a", state: "pending", next: null, fixes: 0, heals: 0 },
    { id: "b", state: "pending", next: null, fixes: 0, heals: 0 },
  ]);
  assert.deepEqual(emits[1].tasks[0], { id: "a", state: "running", next: "review", fixes: 1, heals: 0 });
  assert.deepEqual(emits.at(-1).merged, ["a", "b"]);
}

// A writer that reports its own work as not done is rejected by pi-subagents'
// acceptance; it is not retried, and its blocked report goes to a diagnosis.
{
  const rejected = "Acceptance rejected: Required criterion 'criterion-1' was reported as not-satisfied.";
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    review: { "review-a-1": needsWork },
    impl: {
      "impl-b": { result: { ok: false, error: rejected, structuredOutput: { ...taskGate("b"), ok: false, reason: "report blocked: needs the port", report: { status: "blocked", why: "needs the port" } } } },
    },
    fix: { "fix-a-1": { result: { ok: false, error: rejected } } },
    diagnose: { "diagnose-b-1": diagnosis("decide", "what port?") },
  });
  const receipt = await run(f.runs, base);
  assert.equal(f.items().filter((i) => /-retry$/.test(i.key)).length, 0);
  const k = byKey(f);
  assert.match(k["diagnose-b-1"].task, /What went wrong: the implementer reported blocked: report blocked: needs the port/);
  assert.match(k["diagnose-a-1"].task, /What went wrong: fix round 1 reported that it cannot finish/);
  assert.deepEqual(receipt.decide.map((d) => d.id).sort(), ["a", "b"]);
}

// Three waves in a chain; each task builds on the one before.
{
  const f = fake({ plan: planOf([spec("a"), spec("b", ["a"]), spec("c", ["b"])]) });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [
    ["intake"],
    ["impl-a"],
    ["review-a-1"],
    ["impl-b"],
    ["review-b-1"],
    ["impl-c"],
    ["review-c-1"],
    ["integrate"],
  ]);
  assert.match(byKey(f)["impl-b"].task, /: a \(branch pi\/a\)$/m);
  assert.match(byKey(f)["impl-c"].task, /: b \(branch pi\/b\)$/m);
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,c:pi/c' --branch 'implement/p' --tidy yes");
  assert.deepEqual(receipt.merged, ["a", "b", "c"]);
}

// An integration that fails twice leaves the finished branches in the receipt.
{
  const f = fake({ integrate: { integrate: "boom", "integrate-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["integrate"], ["integrate-retry"], ["diagnose-integration-1"]]);
  assert.equal(f.batches[4][0].output, "/t/p/integration.retry.md");
  assert.match(byKey(f)["diagnose-integration-1"].gate.command, / --allow 'retry,decide'$/);
  assert.match(byKey(f)["diagnose-integration-1"].task, /Evidence: \/t\/p\/integration\.retry\.md, \/t\/p\/heavy\.md/);
  assert.equal(f.batches[4][0].gate.command, f.batches[3][0].gate.command);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    heavy_check: null,
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    open: ["integration failed: boom", "finished branches: a:pi/a"],
    children: 6,
    pr_text: "",
  });
}

// An integration the gate does not accept is reported with what it did get done.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    integrate: {
      integrate: {
        ok: false,
        reasons: ["not merged: b", "heavy checks: fail: red"],
        branch: "implement/p",
        head: "h",
        merged: ["a"],
        unmerged: ["b"],
        clean: true,
        heavy_check: "fail: red",
        pr_text: "PR",
      },
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt, {
    branch: "implement/p",
    merged: ["a"],
    set_aside: [],
    skipped: [],
    heavy_check: "fail: red",
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    open: ["integration: not merged: b", "integration: heavy checks: fail: red"],
    children: 7,
    pr_text: "PR",
  });
}

// A task worktree the cleanup could not remove is reported, the run still ends well.
{
  const f = fake({
    integrate: {
      integrate: {
        ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true,
        heavy_check: "none", pr_text: "PR", tidied: [], tidy_problems: ["a: worktree /wt/a kept: contains untracked files"],
      },
    },
  });
  const receipt = await run(f.runs, base);
  assert.match(byKey(f).integrate.gate.command, / --tidy yes$/);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, ["cleanup: a: worktree /wt/a kept: contains untracked files"]);
}

// An integration with no result from the gate names the branches.
{
  const f = fake({ integrate: { integrate: undefined } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.open, ["the integration check did not run; finished branches: a:pi/a"]);
}

// The branch argument names the integration branch.
{
  const f = fake();
  const receipt = await run(f.runs, { ...base, branch: "feature/x" });
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a' --branch 'feature/x' --tidy yes");
  assert.match(byKey(f).integrate.task, /Integration branch: feature\/x/);
  assert.equal(receipt.branch, "feature/x");
}

// A path with a quote is shell-escaped in the gate commands and in the slug.
{
  const f = fake();
  await run(f.runs, { plan: "/tmp/it's", repo: "/r o" });
  const k = byKey(f);
  assert.equal(k.intake.gate.command, "recipe-gate plan '/tmp/it'\\''s' --repo '/r o'");
  assert.equal(k["impl-a"].gate.command.split(" --check ")[0], "recipe-gate task '/tmp/it'\\''s/impl-a.md'");
  assert.match(k.integrate.gate.command, / --branch 'implement\/it-s' --tidy yes$/);
}

console.log("implement graph: ok");
