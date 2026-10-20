/**
 * Dry run of the implement workflow script against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (waves, briefs, gate
 * commands, review and fix rounds, set-aside and skipped tasks, retry,
 * integration, receipt); pi-subagents' semantics and the gates are not
 * exercised, and the gate results are the fake's.
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

const spec = (id, depends = [], thinking = "medium") => ({
  id,
  owns: [`${id}.nix`, `lib/${id}`],
  reads: [],
  check: `nixfmt --check ${id}.nix`,
  depends,
  thinking,
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

// Each table maps a child key to its result; an unlisted key gets the default
// (a good plan, a good task, a clean verdict, a successful fix, a successful
// integration); a string is a failure message.
function fake({ plan = planOf([spec("a")]), intake = {}, impl = {}, review = {}, fix = {}, integrate = {} } = {}) {
  const batches = [];
  const answer = (table, key, fallback) => {
    const given = key in table ? table[key] : fallback;
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
              return answer(review, item.key, clean);
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

// Two waves. a is clean first time; b (xhigh) needs one fix round; c never
// gets clean and is set aside after two; d depends on a and b and runs; e
// depends on c and is skipped.
{
  const plan = planOf([spec("a"), spec("b", [], "xhigh"), spec("c"), spec("d", ["a", "b"]), spec("e", ["c"])]);
  const f = fake({
    plan,
    review: {
      "review-b-1": needsWork,
      "review-c-1": needsWork,
      "review-c-2": needsWork,
      "review-c-3": needsWork,
    },
  });
  const receipt = await run(f.runs, { ...base, model: "prov/mod" });
  assert.deepEqual(keys(f), [
    ["intake"],
    ["impl-a", "impl-b", "impl-c"],
    ["review-a-1", "review-b-1", "review-c-1"],
    ["fix-b-1", "fix-c-1"],
    ["review-b-2", "review-c-2"],
    ["fix-c-2"],
    ["review-c-3"],
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
  assert.equal(k["impl-a"].model, undefined);
  assert.deepEqual(k["impl-a"].gate, {
    command: "recipe-gate task '/t/p/impl-a.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r'",
    output: "json",
    timeoutMs: 900000,
  });
  assert.match(k["impl-a"].task, /Task file: \/t\/p\/tasks\/a\.md \(read it first\)/);
  assert.match(k["impl-a"].task, /Plan: \/t\/p\/plan\.md/);
  assert.match(k["impl-a"].task, /Write the report to \/t\/p\/impl-a\.md/);
  assert.doesNotMatch(k["impl-a"].task, /merge each/);
  assert.equal(k["impl-b"].model, "prov/mod:xhigh");
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
    command: "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,d:pi/d' --branch 'implement/p'",
    output: "json",
  });
  assert.match(k.integrate.task, /Finished tasks, as id:branch: a:pi\/a,b:pi\/b,d:pi\/d/);
  assert.match(k.integrate.task, /worktree add -b implement\/p \/t\/p\/integration HEAD/);
  assert.match(k.integrate.task, /Write \/t\/p\/heavy\.md/);
  assert.match(k.integrate.task, /Write the pull request title and body to \/t\/p\/pr\.md/);
  assert.match(k.integrate.task, /Never merge into main and never push/);
  assertUniqueOutputs(f);

  assert.deepEqual(receipt, {
    branch: "implement/p",
    merged: ["a", "b", "d"],
    set_aside: [{ id: "c", reason: "review still needs-work after 2 fix rounds; see /t/p/review-c-3.md" }],
    skipped: ["e"],
    heavy_check: "pass",
    open: [],
    children: 16,
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

// A blocked task is set aside without a review; its dependent is skipped; with
// nothing finished there is no integration.
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
  assert.deepEqual(keys(f), [["intake"], ["impl-a"]]);
  assert.deepEqual(receipt, {
    branch: null,
    merged: [],
    set_aside: [{ id: "a", reason: "report blocked: baseline failing" }],
    skipped: ["b"],
    heavy_check: null,
    open: ["no task finished, so there is nothing to integrate"],
    children: 2,
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

// An implementer that fails twice is set aside; the other task goes on and the
// retry writes beside the first report with its own gate path.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    impl: { "impl-a": "boom", "impl-a-retry": "boom" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a", "impl-b"], ["impl-a-retry"], ["review-b-1"], ["integrate"]]);
  const retry = f.batches[2][0];
  assert.equal(retry.output, "/t/p/impl-a.retry.md");
  assert.match(retry.task, /Write the report to \/t\/p\/impl-a\.retry\.md/);
  assert.equal(
    retry.gate.command,
    "recipe-gate task '/t/p/impl-a.retry.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r'",
  );
  assert.equal(retry.worktree, true);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "implementer failed: boom" }]);
  assert.deepEqual(receipt.merged, ["b"]);
  assert.equal(receipt.children, 6);
}

// An implementer that fails once and then succeeds is reviewed from its retry.
{
  const f = fake({ impl: { "impl-a": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["impl-a-retry"], ["review-a-1"], ["integrate"]]);
  assert.match(byKey(f)["review-a-1"].task, /Implementer report: \/t\/p\/impl-a\.retry\.md/);
  assert.deepEqual(receipt.set_aside, []);
}

// A fix that fails twice sets the task aside; the retry resumes the failed run.
{
  const f = fake({
    review: { "review-a-1": needsWork },
    fix: { "fix-a-1": "x", "fix-a-1-retry": "x" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["fix-a-1-retry"]]);
  assert.equal(f.batches[4][0].resume, "run-fix-a-1");
  assert.equal(f.batches[4][0].output, "/t/p/fix-a-1.retry.md");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "fix round 1 failed: x" }]);
  assert.equal(receipt.children, 5);
}

// A reviewer that fails twice sets the task aside.
{
  const f = fake({ review: { "review-a-1": "boom", "review-a-1-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["review-a-1-retry"]]);
  assert.equal(f.batches[3][0].gate.command, "recipe-gate verdict '/t/p/review-a-1.retry.md'");
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "review failed: boom" }]);
}

// A verdict that cannot be read is not looped.
{
  const f = fake({ review: { "review-a-1": { ok: false, verdict: "invalid" } } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"]]);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "review verdict unreadable; see /t/p/review-a-1.md" }]);
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
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,c:pi/c' --branch 'implement/p'");
  assert.deepEqual(receipt.merged, ["a", "b", "c"]);
}

// An integration that fails twice leaves the finished branches in the receipt.
{
  const f = fake({ integrate: { integrate: "boom", "integrate-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["impl-a"], ["review-a-1"], ["integrate"], ["integrate-retry"]]);
  assert.equal(f.batches[4][0].output, "/t/p/integration.retry.md");
  assert.equal(f.batches[4][0].gate.command, f.batches[3][0].gate.command);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    heavy_check: null,
    open: ["integration failed: boom", "finished branches: a:pi/a"],
    children: 5,
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
    open: ["integration: not merged: b", "integration: heavy checks: fail: red"],
    children: 6,
    pr_text: "PR",
  });
}

// An integration with no result from the gate names the branches.
{
  const f = fake({ integrate: { integrate: undefined } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.open, ["the integration check did not run; finished branches: a:pi/a"]);
}

// xhigh without a model argument runs at the role's default and says so.
{
  const f = fake({ plan: planOf([spec("a", [], "xhigh")]) });
  const receipt = await run(f.runs, base);
  assert.equal(byKey(f)["impl-a"].model, undefined);
  assert.deepEqual(receipt.open, ["a: the task asks for xhigh thinking and no model was given, so it ran at the role's default"]);
}

// The branch argument names the integration branch.
{
  const f = fake();
  const receipt = await run(f.runs, { ...base, branch: "feature/x" });
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a' --branch 'feature/x'");
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
  assert.match(k.integrate.gate.command, / --branch 'implement\/it-s'$/);
}

console.log("implement workflow: ok");
