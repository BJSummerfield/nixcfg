/**
 * Dry run of the implement graph with the shared library against a fake `runs`. Run by
 * `nix flake check`. It proves the script's own logic (waves, briefs, gate
 * commands, review and fix rounds, set-aside and skipped tasks, retry,
 * integration, receipt); the gates are not exercised, and the gate results
 * are the fake's. One scenario runs again through the runner's port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./split.test.mjs";
import graph from "./graph.mjs";
import { portOf, runThroughRunner } from "../runner/fake.mjs";

const run = (runs, args, emit) => graph(Object.freeze(args), portOf(runs, emit));

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
const pinGate = { ok: true, reason: "", repo: "/r", base: "base0", base_ref: "refs/recipes/p/base", reused: false };
const flagOf = (command, flag) => (command.match(new RegExp(` --${flag} '?([^' ]*)`)) || [])[1];
const mergeGate = (item, extra = {}) => ({
  ok: true,
  reason: "",
  worktree: item.gate.command.match(/^recipe-gate merge '([^']*)'/)[1],
  branch: flagOf(item.gate.command, "branch"),
  head: "head-" + flagOf(item.gate.command, "id"),
  onto: flagOf(item.gate.command, "onto"),
  tips: [],
  merged: flagOf(item.gate.command, "tips")
    .split(",")
    .filter(Boolean)
    .map((p) => p.split(":")[0]),
  conflict: null,
  resolved: [],
  check: null,
  ...extra,
});
const scopeDir = (scope) => (scope === "integration" ? "/t/p/integration" : `/t/p/deps/${scope}`);
const scopeBranch = (scope) => (scope === "integration" ? "implement/p" : `implement/p-deps-${scope}`);
const conflictAt = (scope, id, files = ["x.nix"], merged = []) => ({
  ok: false,
  reason: `merge of ${id} has conflicts`,
  worktree: scopeDir(scope),
  branch: scopeBranch(scope),
  head: "h",
  onto: "refs/recipes/p/base",
  tips: [],
  merged,
  conflict: { id, files },
  resolved: [],
  check: null,
});

// A task gate that read a handoff note: no check ran, the head and the commits are the gate's.
const handoffGate = (id, over = {}) => ({
  ...taskGate(id),
  ok: false,
  reason: "report handoff: ran out of context",
  report: { status: "handoff", why: "ran out of context" },
  check: null,
  ...over,
});
// The result of a child that handed off, as the port builds it.
const handedOff = (id, over = {}) => ({
  result: {
    ok: true,
    structuredOutput: handoffGate(id, over.gate),
    handoff: { line: "handoff: " + (over.line || "ran out of context"), unread: [], note: over.note === undefined ? `/t/p/impl-${over.key || id}.md` : over.note, empty: over.note === null },
    usage: { firstContext: over.firstContext ?? 1000 },
    budget: { tokens: 100000 },
    ...(over.finalText ? { finalText: over.finalText } : {}),
  },
});
const piece = (id, over = {}) => ({ id, owns: [`lib/a/${id}`], reads: [], check: `nixfmt --check ${id}.nix`, depends: [], est: 400, file: `/t/p/split/tasks/${id}.md`, ...over });
const splitPlan = (ids) => planOf(ids.map((id) => piece(id)));

function fake({ plan = planOf([spec("a")]), pin = pinGate, back = undefined, intake = {}, impl = {}, review = {}, fix = {}, integrate = {}, diagnose = {}, merge = {}, planner = {} } = {}) {
  const batches = [];
  const answer = (table, key, fallback) => {
    const given = key in table ? table[key] : fallback;
    if (given && given.result) return { runId: `run-${key}`, ...given.result };
    return typeof given === "string" ? failed(key, given) : ok(key, given);
  };
  const idOf = (key) => key.replace(/^impl-(piece-)?/, "").replace(/-retry$/, "");
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
              if (item.key.startsWith("pin")) return answer({}, item.key, pin);
              if (item.key.startsWith("resume")) return answer({}, item.key, back);
              if (/^(deps-|merge|join-)/.test(item.key)) return answer(merge, item.key, mergeGate(item));
              if (item.key.startsWith("handoff-")) return answer(intake, item.key, handoffGate(item.key.replace(/^handoff-/, "").replace(/-\d+$/, "")));
              return answer(intake, item.key, plan);
            case "planner": {
              const parent = item.key.replace(/^split-/, "").replace(/-\d+$/, "");
              return answer(planner, item.key, splitPlan([parent + "-1", parent + "-2"]));
            }
            case "implementer":
              if (item.key.startsWith("resolve-")) return answer(merge, item.key, mergeGate(item));
              return item.key.startsWith("integrate")
                ? answer(integrate, item.key, integrated(item))
                : answer(impl, item.key, taskGate(idOf(item.key)));
            case "reviewer":
              return item.key.startsWith("diagnose-") ? answer(diagnose, item.key, decided) : answer(review, item.key, { ...clean, branch: `pi/${idOf(item.key.replace(/^review-/, "impl-").replace(/-\d+$/, ""))}`, worktree: `/rw/${item.key}` });
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
  const answers = {
    plan,
    review: {
      "review-b-1": needsWork,
      "review-c-1": needsWork,
      "review-c-2": needsWork,
      "review-c-3": needsWork,
    },
  };
  const f = fake(answers);
  const receipt = await run(f.runs, base);
  assert.deepEqual(await runThroughRunner(graph, fake(answers).runs, base), JSON.parse(JSON.stringify(receipt)));
  assert.deepEqual(keys(f), [
    ["intake"],
    ["pin"],
    ["impl-a", "impl-b", "impl-c"],
    ["review-a-1"],
    ["review-b-1"],
    ["review-c-1"],
    ["fix-b-1", "fix-c-1"],
    ["review-b-2"],
    ["review-c-2"],
    ["fix-c-2"],
    ["review-c-3"],
    ["diagnose-c-1"],
    ["deps-d"],
    ["impl-d"],
    ["review-d-1"],
    ["merge"],
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
    command: "recipe-gate task '/t/p/impl-a.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r' --base 'base0' --run '/t/p' --id 'a'",
    output: "json",
    timeoutMs: 900000,
  });
  assert.equal(k["impl-a"].baseRef, "refs/recipes/p/base");
  assert.equal(k["impl-b"].baseRef, "refs/recipes/p/base");
  assert.equal(k["impl-c"].baseRef, "refs/recipes/p/base");

  assert.equal(k.pin.agent, "scout");
  assert.deepEqual(k.pin.gate, { command: "recipe-gate pin '/t/p' --repo '/r'", output: "json" });
  assert.doesNotMatch(k.pin.task, /if it reports a problem/);

  assert.equal(k["deps-d"].agent, "scout");
  assert.deepEqual(k["deps-d"].gate, {
    command:
      "recipe-gate merge '/t/p/deps/d' --dir '/t/p' --branch 'implement/p-deps-d' --tips 'a:pi/a,b:pi/b' --onto 'refs/recipes/p/base' --kind deps --id d",
    output: "json",
  });
  assert.equal(k["impl-d"].baseRef, "refs/heads/implement/p-deps-d");
  assert.equal(k["impl-d"].worktree, true);
  assert.match(k["impl-d"].gate.command, / --base 'head-d' --run '\/t\/p' --id 'd'$/);
  assert.match(k["impl-d"].task, /your branch already holds them: a \(branch pi\/a\), b \(branch pi\/b\)\. Do not merge anything\./);
  assert.match(k["review-d-1"].task, /Diff to review: git diff head-d\.\.pi\/d/);
  assert.equal(k["review-d-1"].baseRef, "refs/heads/pi/d");

  assert.equal(k.merge.agent, "scout");
  assert.deepEqual(k.merge.gate, {
    command:
      "recipe-gate merge '/t/p/integration' --dir '/t/p' --branch 'implement/p' --tips 'd:pi/d' --onto 'refs/recipes/p/base' --kind integration --id integration",
    output: "json",
  });
  assert.match(k["impl-a"].task, /Task file: \/t\/p\/tasks\/a\.md \(read it first\)/);
  assert.match(k["impl-a"].task, /Plan: \/t\/p\/plan\.md/);
  assert.match(k["impl-a"].task, /Write the report to \/t\/p\/impl-a\.md/);
  assert.doesNotMatch(k["impl-a"].task, /merge each/);
  assert.equal(k["impl-b"].model, undefined);
  assert.match(k["impl-b"].task, /^Research notes gathered for this task, if any, answer: which flag order\?\. They are under \/t\/p\/research\/b\/; list that directory and read what is there before the first edit\.$/m);
  assert.doesNotMatch(k["impl-a"].task, /Research notes/);
  assert.match(k["impl-a"].task, /run `recipe-gate task .*`; if it reports a problem, fix the file and run it again before you finish, unless your report says blocked or failed\./);
  assert.doesNotMatch(k.integrate.task, /if it reports a problem/);

  assert.equal(k["review-b-1"].agent, "reviewer");
  assert.equal(k["review-b-1"].output, "/t/p/review-b-1.md");
  assert.deepEqual(k["review-b-1"].gate, { command: "recipe-gate verdict '/t/p/review-b-1.md' --run '/t/p' --id 'b'", output: "json" });
  assert.match(k["review-b-1"].task, /^Review a diff on a branch \(the diff variant\)\.$/m);
  assert.match(k["review-b-1"].task, /Branch: pi\/b/);
  assert.match(k["review-b-1"].task, /Worktree: your working directory is your own worktree of the branch; .*make no other worktree\. The implementer.s worktree \/wt\/b is not yours/);
  assert.equal(k["review-b-1"].worktree, true);
  assert.equal(k["review-b-1"].baseRef, "refs/heads/pi/b");
  assert.equal(k["review-b-1"].big, true);
  assert.equal(k.integrate.big, true);
  assert.match(k["review-b-1"].task, /Diff to review: git diff base0..pi\/b/);
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
  assert.match(k.integrate.task, /Integration worktree: \/t\/p\/integration \(already made/);
  assert.match(k.integrate.task, /Create no worktree and merge nothing/);
  for (const item of f.items()) assert.doesNotMatch(item.task, /git merge|git worktree add/);
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
    base: "base0",
    branch: "implement/p",
    merged: ["a", "b", "d"],
    set_aside: [{ id: "c", reason: "needs a decision: a person has to choose" }],
    skipped: ["e"],
    report: ["a: merged", "b: merged", "c: set aside (needs a decision: a person has to choose)", "d: merged", "e: skipped (c not done)"],
    heavy_check: "pass",
    healed: [],
    decide: [{ id: "c", step: "review", question: "a person has to choose", diagnosis: "/t/p/diagnosis-c-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: [],
    left: [{ id: "c", kind: "task", branch: "pi/c", worktree: "/wt/c" }],
    cleanup: "recipe-gate abandon '/t/p' --keep 'implement/p'",
    children: 20,
    pr_text: "PR text",
  });
}

// A plan that is not ready is refused after the one child that runs the gate.
{
  const f = fake({ plan: badPlan });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"]]);
  assert.deepEqual(receipt, {
    base: null,
    left: [],
    cleanup: "",
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    report: [],
    heavy_check: null,
    healed: [],
    decide: [],
    resumed: { done: [], continued: [], answered: [] },
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
  assert.deepEqual(keys(g), [["intake"], ["intake-retry"], ["pin"], ["impl-a"], ["review-a-1"], ["merge"], ["integrate"]]);
  assertUniqueOutputs(g);
  assert.deepEqual(done.merged, ["a"]);
  assert.equal(done.children, 7);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["diagnose-a-1"]]);
  assert.match(byKey(f)["diagnose-a-1"].gate.command, / --allow 'replan,decide'$/);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the implementer reported blocked: report blocked: baseline failing/);
  assert.deepEqual(receipt, {
    base: "base0",
    left: [{ id: "a", kind: "task", branch: "pi/a", worktree: "/wt/a" }],
    cleanup: "recipe-gate abandon '/t/p'",
    branch: null,
    merged: [],
    set_aside: [{ id: "a", reason: "needs a decision: a person has to choose" }],
    skipped: ["b"],
    report: ["a: set aside (needs a decision: a person has to choose)", "b: skipped (a not done)"],
    heavy_check: null,
    healed: [],
    decide: [{ id: "a", step: "implement", question: "a person has to choose", diagnosis: "/t/p/diagnosis-a-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: ["no task finished, so there is nothing to integrate"],
    children: 4,
    pr_text: "",
  });
}

// A task whose own check is red goes straight to a fix round, then a review.
{
  const f = fake({
    impl: { "impl-a": { ...taskGate("a"), ok: false, reason: "check failed (exit 1): red" } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["fix-a-1"], ["review-a-1"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["fix-a-1"].resume, "run-impl-a");
  assert.match(k["fix-a-1"].task, /The task check reported: check failed \(exit 1\): red/);
  assert.doesNotMatch(k["review-a-1"].task, /re-review/);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.children, 7);
}

// An implementer that fails twice goes to a diagnosis; the other task goes on
// and the retry writes beside the first report with its own gate path.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    impl: { "impl-a": "boom", "impl-a-retry": "boom" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a", "impl-b"], ["impl-a-retry"], ["review-b-1"], ["diagnose-a-1"], ["merge"], ["integrate"]]);
  const retry = f.batches[3][0];
  assert.equal(retry.output, "/t/p/impl-a.retry.md");
  assert.match(retry.task, /Write the report to \/t\/p\/impl-a\.retry\.md/);
  assert.equal(
    retry.gate.command,
    "recipe-gate task '/t/p/impl-a.retry.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r' --base 'base0' --run '/t/p' --id 'a'",
  );
  assert.equal(retry.worktree, true);
  assert.equal(retry.baseRef, "refs/recipes/p/base");
  assertUniqueOutputs(f);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the implementer failed twice: boom/);
  assert.deepEqual(receipt.merged, ["b"]);
  assert.equal(receipt.children, 9);
}

// An implementer that fails once and then succeeds is reviewed from its retry.
{
  const f = fake({ impl: { "impl-a": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["impl-a-retry"], ["review-a-1"], ["merge"], ["integrate"]]);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["fix-a-1-retry"], ["diagnose-a-1"]]);
  assert.equal(f.batches[5][0].resume, "run-fix-a-1");
  assert.equal(f.batches[5][0].output, "/t/p/fix-a-1.retry.md");
  assertUniqueOutputs(f);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: fix round 1 failed twice: x/);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
  assert.equal(receipt.children, 7);
}

// A reviewer that fails twice goes to a diagnosis that may retry it.
{
  const f = fake({ review: { "review-a-1": "boom", "review-a-1-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["review-a-1-retry"], ["diagnose-a-1"]]);
  assert.equal(f.batches[4][0].gate.command, "recipe-gate verdict '/t/p/review-a-1.retry.md' --run '/t/p' --id 'a'");
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["diagnose-a-1"], ["merge"], ["integrate"]]);
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
  assert.deepEqual(keys(g), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["diagnose-a-1"], ["fix-a-1"], ["review-a-2"], ["merge"], ["integrate"]]);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["deps-b"], ["impl-b"], ["diagnose-b-1"], ["impl-b-2"], ["review-b-1"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-b-2"].output, "/t/p/impl-b-2.md");
  assert.equal(k["impl-b-2"].worktree, true);
  assert.match(k["impl-b-2"].gate.command, / --owns 'b\.nix,lib\/b,a\.nix' /);
  assert.match(k["impl-b-2"].task, /This is attempt 2\. .*the diagnosis at \/t\/p\/diagnosis-b-1\.md says why, and its ## Brief section is the revised task/);
  assert.match(k["impl-b-2"].task, /Besides the task's own files you may change: a\.nix/);
  assert.match(k["impl-b-2"].task, /: a \(branch pi\/a\)\. Do not merge anything\./);
  assert.equal(k["impl-b-2"].baseRef, "refs/heads/implement/p-deps-b");
  assert.match(k["impl-b-2"].gate.command, / --base .head-b. /);
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
    ["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["review-a-2"], ["fix-a-2"], ["review-a-3"], ["diagnose-a-1"], ["fix-a-3"], ["review-a-4"], ["merge"], ["integrate"],
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["diagnose-a-1"], ["impl-a-2"], ["diagnose-a-2"]]);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["diagnose-a-1"], ["impl-a-2"], ["diagnose-a-2"], ["impl-a-3"]]);
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

// A review rejected for its quotes is diagnosed without continue.
{
  const f = fake({
    review: {
      "review-a-1": {
        ok: false,
        asked: "yes",
        sound: "yes",
        clean: false,
        verdict: "invalid",
        reason: "quote not found in its file: a.nix:3",
        missing: [{ location: "a.nix:3", quote: "x = 1;" }],
      },
    },
    diagnose: { "diagnose-a-1": { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false, problem: "no action line" } },
  });
  const receipt = await run(f.runs, base);
  assert.equal(
    byKey(f)["diagnose-a-1"].gate.command,
    "recipe-gate diagnosis '/t/p/diagnosis-a-1.md' --allow 'retry,decide'",
  );
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the review quotes text not found in the cited files: a\.nix:3/);
  assert.deepEqual(receipt.decide, [
    { id: "a", step: "review", question: "the review quotes text not found in the cited files: a.nix:3; the diagnosis could not be read: no action line", diagnosis: "/t/p/diagnosis-a-1.md" },
  ]);
}

// An integration the gate does not accept is diagnosed and run once more.
{
  const f = fake({
    integrate: { integrate: { ok: false, reasons: ["not merged: a"], branch: "implement/p", head: "h", merged: [], unmerged: ["a"], clean: true, heavy_check: "none", pr_text: "" } },
    diagnose: { "diagnose-integration-1": diagnosis("retry", "the merge stopped on a conflict it can resolve") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["merge"], ["integrate"], ["diagnose-integration-1"], ["integrate-2"]]);
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

// A writer that reports its own work as not done is marked stopped by the
// runner; it is not retried, and its blocked report goes to a diagnosis.
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
    ["pin"],
    ["impl-a"],
    ["review-a-1"],
    ["deps-b"],
    ["impl-b"],
    ["review-b-1"],
    ["deps-c"],
    ["impl-c"],
    ["review-c-1"],
    ["merge"],
    ["integrate"],
  ]);
  assert.match(byKey(f)["impl-b"].task, /: a \(branch pi\/a\)\. Do not merge anything\./);
  assert.match(byKey(f)["impl-c"].task, /: b \(branch pi\/b\)\. Do not merge anything\./);
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,c:pi/c' --branch 'implement/p' --tidy yes");
  assert.match(byKey(f).merge.gate.command, / --tips 'c:pi\/c' /);
  assert.deepEqual(receipt.merged, ["a", "b", "c"]);
}

// An integration that fails twice leaves the finished branches in the receipt.
{
  const f = fake({ integrate: { integrate: "boom", "integrate-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["merge"], ["integrate"], ["integrate-retry"], ["diagnose-integration-1"]]);
  assert.equal(f.batches[6][0].output, "/t/p/integration.retry.md");
  assert.match(byKey(f)["diagnose-integration-1"].gate.command, / --allow 'retry,decide'$/);
  assert.match(byKey(f)["diagnose-integration-1"].task, /Evidence: \/t\/p\/integration\.retry\.md, \/t\/p\/heavy\.md/);
  assert.equal(f.batches[6][0].gate.command, f.batches[5][0].gate.command);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    base: "base0",
    left: [
      { id: "a", kind: "task", branch: "pi/a", worktree: "/wt/a" },
      { id: "a", kind: "review", branch: "pi/a", worktree: "/rw/review-a-1" },
      { id: "integration", kind: "integration", branch: "implement/p", worktree: "/t/p/integration" },
    ],
    cleanup: "recipe-gate abandon '/t/p'",
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    report: ["a: not merged"],
    heavy_check: null,
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: ["integration failed: boom", "finished branches: a:pi/a"],
    children: 8,
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
    base: "base0",
    left: [
      { id: "a", kind: "task", branch: "pi/a", worktree: "/wt/a" },
      { id: "b", kind: "task", branch: "pi/b", worktree: "/wt/b" },
      { id: "a", kind: "review", branch: "pi/a", worktree: "/rw/review-a-1" },
      { id: "b", kind: "review", branch: "pi/b", worktree: "/rw/review-b-1" },
      { id: "integration", kind: "integration", branch: "implement/p", worktree: "/t/p/integration" },
    ],
    cleanup: "recipe-gate abandon '/t/p'",
    branch: "implement/p",
    merged: ["a"],
    set_aside: [],
    skipped: [],
    report: ["a: merged", "b: not merged"],
    heavy_check: "fail: red",
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: ["integration: not merged: b", "integration: heavy checks: fail: red"],
    children: 9,
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

// A pin the gate refuses ends the run before any implementer.
{
  const f = fake({ pin: { ...pinGate, ok: false, reason: "HEAD of /r is detached" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"]]);
  assert.deepEqual(receipt.open, ["the base could not be pinned: HEAD of /r is detached"]);
  assert.equal(receipt.base, null);
  assert.deepEqual(receipt.left, []);
  assert.equal(receipt.cleanup, "");
  assert.equal(receipt.children, 2);

  const g = fake({ pin: "boom" });
  const failedPin = await run(g.runs, base);
  assert.deepEqual(keys(g), [["intake"], ["pin"], ["pin-retry"]]);
  assert.deepEqual(failedPin.open, ["the base could not be pinned: boom"]);
}

// An integration conflict gets one resolver whose gate carries the conflicting
// task's check; the integration child follows.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    merge: { merge: conflictAt("integration", "b", ["b.nix", "lib/b"], ["a"]) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a", "impl-b"], ["review-a-1"], ["review-b-1"], ["merge"], ["resolve-integration-1"], ["integrate"]]);
  const k = byKey(f);
  const r = k["resolve-integration-1"];
  assert.equal(r.agent, "implementer");
  assert.equal(r.worktree, false);
  assert.equal(r.output, "/t/p/resolve-integration-1.md");
  assert.equal(r.gate.command, k.merge.gate.command + " --check 'nixfmt --check b.nix'");
  assert.equal(r.gate.timeoutMs, 900000);
  assert.match(r.task, /^Worktree: \/t\/p\/integration \(on branch implement\/p;/m);
  assert.match(r.task, /^Branch being merged: pi\/b$/m);
  assert.match(r.task, /^Conflicted files: b\.nix, lib\/b$/m);
  assert.match(r.task, /^Task file of the conflicting task: \/t\/p\/tasks\/b\.md$/m);
  assert.match(r.task, /^Task files of the tasks already merged: \/t\/p\/tasks\/a\.md$/m);
  assert.match(r.task, /Edit only the conflicted files, `git add` them and run `git commit --no-edit`\. Never start, abort or redo a merge, and never edit the repository checkout \/r\./);
  assert.match(r.task, /quote its output: nixfmt --check b\.nix/);
  assert.match(r.task, /write `blocked: <why>` as the first line of the report/);
  assert.doesNotMatch(r.task, /if it reports a problem/);
  assert.deepEqual(receipt.merged, ["a", "b"]);
  assert.deepEqual(receipt.decide, []);
  for (const item of f.items()) assert.doesNotMatch(item.task, /git merge|git worktree add/, item.key);
  assertUniqueOutputs(f);
}

// A resolver that leaves the same conflict, or whose check fails, ends the run
// on a decision and lists what the run made.
{
  const stays = fake({
    plan: planOf([spec("a"), spec("b")]),
    merge: { merge: conflictAt("integration", "b"), "resolve-integration-1": conflictAt("integration", "b") },
  });
  const receipt = await run(stays.runs, base);
  assert.deepEqual(keys(stays).slice(-2), [["merge"], ["resolve-integration-1"]]);
  assert.equal(receipt.branch, null);
  assert.deepEqual(receipt.decide, [
    { id: "integration", step: "integrate", question: "the finished branches could not be merged: conflict merging b in x.nix, left as it was by the resolver", diagnosis: null },
  ]);
  assert.deepEqual(receipt.open, [
    "integration merge: conflict merging b in x.nix, left as it was by the resolver",
    "integration worktree: /t/p/integration on branch implement/p",
    "finished branches: a:pi/a,b:pi/b",
  ]);
  assert.ok(receipt.left.some((l) => l.kind === "task" && l.id === "a"));
  assert.ok(receipt.left.some((l) => l.kind === "review" && l.id === "b"));
  assert.ok(receipt.left.some((l) => l.kind === "integration" && l.worktree === "/t/p/integration"));
  assert.equal(receipt.cleanup, "recipe-gate abandon '/t/p'");
  assert.equal(receipt.base, "base0");

  const red = fake({
    plan: planOf([spec("a"), spec("b")]),
    merge: {
      merge: conflictAt("integration", "b"),
      "resolve-integration-1": { ...conflictAt("integration", "b"), conflict: null, reason: "check failed (exit 1): red" },
    },
  });
  const redReceipt = await run(red.runs, base);
  assert.equal(red.items().some((i) => i.key.startsWith("integrate")), false);
  assert.equal(redReceipt.decide[0].id, "integration");
  assert.match(redReceipt.decide[0].question, /check failed \(exit 1\): red/);
  assert.ok(redReceipt.left.length > 0);
}

// A new conflict on another tip gets another resolver, up to three.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b"), spec("c")]),
    merge: {
      merge: conflictAt("integration", "a", ["a1"]),
      "resolve-integration-1": conflictAt("integration", "b", ["b1"]),
      "resolve-integration-2": conflictAt("integration", "c", ["c1"]),
      "resolve-integration-3": conflictAt("integration", "a", ["a2"]),
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(-3), [["resolve-integration-1"], ["resolve-integration-2"], ["resolve-integration-3"]]);
  assert.match(receipt.decide[0].question, /conflict merging a in a2, still open after 3 resolvers$/);

  const g = fake({
    plan: planOf([spec("a"), spec("b"), spec("c")]),
    merge: {
      merge: conflictAt("integration", "a", ["a1"]),
      "resolve-integration-1": conflictAt("integration", "b", ["b1"]),
    },
  });
  const done = await run(g.runs, base);
  assert.deepEqual(keys(g).slice(-4), [["merge"], ["resolve-integration-1"], ["resolve-integration-2"], ["integrate"]]);
  assert.deepEqual(done.decide, []);
}

// A deps conflict that cannot be resolved sets the task aside and skips what
// builds on it; the rest still integrates.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b", ["a"]), spec("c", ["b"])]),
    merge: { "deps-b": conflictAt("b", "a"), "resolve-b-1": conflictAt("b", "a") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["deps-b"], ["resolve-b-1"], ["merge"], ["integrate"]]);
  const r = byKey(f)["resolve-b-1"];
  assert.equal(r.gate.command, byKey(f)["deps-b"].gate.command + " --check 'nixfmt --check a.nix'");
  assert.match(r.task, /^Worktree: \/t\/p\/deps\/b \(on branch implement\/p-deps-b;/m);
  assert.deepEqual(receipt.set_aside, [
    { id: "b", reason: "needs a decision: the tasks that task b builds on could not be merged: conflict merging a in x.nix, left as it was by the resolver" },
  ]);
  assert.deepEqual(receipt.skipped, ["c"]);
  assert.equal(receipt.decide[0].id, "b");
  assert.equal(receipt.decide[0].step, "deps");
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.left.map((l) => l.kind), []);
}

// The reason a resolver's edit was refused reaches the receipt.
{
  const refused = fake({
    plan: planOf([spec("a"), spec("b")]),
    merge: {
      merge: conflictAt("integration", "b"),
      "resolve-integration-1": { ...conflictAt("integration", "b"), reason: "resolution of b edits files that did not conflict: y.nix" },
    },
  });
  const receipt = await run(refused.runs, base);
  assert.match(receipt.decide[0].question, /left as it was by the resolver: resolution of b edits files that did not conflict: y\.nix/);
}

// A deps conflict a resolver settles lets the dependant start from the deps branch.
{
  const f = fake({
    plan: planOf([spec("a"), spec("b", ["a"])]),
    merge: { "deps-b": conflictAt("b", "a") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["deps-b"], ["resolve-b-1"], ["impl-b"], ["review-b-1"], ["merge"], ["integrate"]]);
  assert.equal(byKey(f)["impl-b"].baseRef, "refs/heads/implement/p-deps-b");
  assert.match(byKey(f).merge.gate.command, / --tips 'b:pi\/b' /);
  assert.deepEqual(receipt.merged, ["a", "b"]);
}

// On a clean finish nothing is left to remove: the integration branch is the
// deliverable, and reviews, dependency worktrees and merged task branches are tidied away.
{
  const f = fake({ plan: planOf([spec("a"), spec("b", ["a"])]) });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.left, []);
  assert.equal(receipt.cleanup, "");
}

// A resume after a stop in the middle of a wave: one task is done, one is
// continued from its branch, one starts fresh.
{
  const back = {
    ok: true,
    base: "base0",
    tasks: {
      a: { branch: "pi/a", head: "ha", review: "clean", merged: false },
      b: { branch: "pi/b", head: "hb", review: "needs-work", merged: false },
    },
  };
  const f = fake({ plan: planOf([spec("a"), spec("b"), spec("c")]), back });
  const receipt = await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.deepEqual(keys(f).slice(0, 4), [["intake"], ["pin"], ["resume"], ["impl-b", "impl-c"]]);
  assert.equal(k.resume.agent, "scout");
  assert.deepEqual(k.resume.gate, { command: "recipe-gate resume '/t/p' --repo '/r' --branch 'implement/p'", output: "json" });
  assert.equal(k["impl-a"], undefined);
  assert.equal(k["impl-b"].baseRef, "refs/heads/pi/b");
  assert.match(k["impl-b"].task, /Work already on this branch from an earlier run: continue it; do not start over\./);
  assert.equal(k["impl-c"].baseRef, "refs/recipes/p/base");
  assert.doesNotMatch(k["impl-c"].task, /earlier run/);
  assert.deepEqual(receipt.resumed, { done: ["a"], continued: ["b"], answered: [] });
  assert.deepEqual(receipt.merged, ["a", "b", "c"]);
  assert.deepEqual(receipt.open, []);
}

// A task that was set aside is launched again with the user's decision.
{
  const back = { ok: true, base: "base0", tasks: { a: { branch: "pi/a", head: "ha", review: "needs-work", merged: false } } };
  const f = fake({ back });
  const receipt = await run(f.runs, { ...base, resume: true, answers: { a: "use the second option" } });
  const k = byKey(f);
  assert.match(k["impl-a"].task, /Decision from the user: use the second option/);
  assert.match(k["impl-a"].task, /continue it; do not start over/);
  assert.deepEqual(receipt.resumed, { done: [], continued: ["a"], answered: ["a"] });

  const g = fake({ back: { ok: true, base: "base0", tasks: {} } });
  const fresh = await run(g.runs, { ...base, resume: true, answers: { a: "go" } });
  assert.match(byKey(g)["impl-a"].task, /Decision from the user: go/);
  assert.deepEqual(fresh.resumed, { done: [], continued: [], answered: ["a"] });
}

// A resume gate that fails leaves a fresh run and an open line.
{
  const f = fake({ back: { ok: false, reason: "no ledger in /t/p" } });
  const receipt = await run(f.runs, { ...base, resume: true });
  assert.deepEqual(keys(f).slice(0, 4), [["intake"], ["pin"], ["resume"], ["impl-a"]]);
  assert.equal(byKey(f)["impl-a"].baseRef, "refs/recipes/p/base");
  assert.deepEqual(receipt.open, ["the earlier run could not be read, so this run starts fresh: no ledger in /t/p"]);
  assert.deepEqual(receipt.resumed, { done: [], continued: [], answered: [] });
  assert.deepEqual(receipt.merged, ["a"]);

  const g = fake({ back: "boom" });
  const failedBack = await run(g.runs, { ...base, resume: true });
  assert.match(failedBack.open[0], /starts fresh: boom/);
  assert.deepEqual(failedBack.merged, ["a"]);
}

// A resume refreshes the recorded tips of every merge, and only then.
{
  const back = { ok: true, base: "base0", tasks: { a: { branch: "pi/a", head: "ha", review: "clean", reviews: 1, review_file: "/t/p/review-a-1.md", merged: false } } };
  const f = fake({ plan: planOf([spec("a"), spec("b"), spec("c", ["b"])]), back });
  await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.match(k["deps-c"].gate.command, / --refresh yes/);
  assert.match(k.merge.gate.command, / --refresh yes/);
  const g = fake({ plan: planOf([spec("a")]) });
  await run(g.runs, base);
  assert.doesNotMatch(byKey(g).merge.gate.command, /--refresh/);
}

// A continued task with dependencies merges them as a fresh task does; its branch is only the worktree's base ref.
{
  const back = { ok: true, base: "base0", tasks: { c: { branch: "pi/c", head: "hc", review: "needs-work", reviews: 1, review_file: "/t/p/review-c-1.md", merged: false } } };
  const f = fake({ plan: planOf([spec("b"), spec("c", ["b"])]), back });
  await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.match(k["deps-c"].gate.command, / --onto 'refs\/recipes\/p\/base'/);
  assert.equal(k["impl-c"].baseRef, "refs/heads/pi/c");
  assert.match(k["impl-c"].gate.command, / --base 'head-c' /);
  assert.doesNotMatch(k["impl-c"].gate.command, / --base 'hc' /);
  assert.match(k.merge.gate.command, / --onto 'refs\/recipes\/p\/base'/);
}

// A review worktree the tidy could not remove, or one the verdict gate could not record, stays in
// `left` after a passing integration, with a cleanup command that removes it.
{
  const left_over = [{ kind: "review", id: "a", branch: "pi/a", worktree: "/rw/review-a-1" }];
  const gateOut = { ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true, heavy_check: "pass", pr_text: "PR", left_over };
  const stuck = fake({ integrate: { integrate: gateOut } });
  const receipt = await run(stuck.runs, base);
  assert.deepEqual(receipt.left, [{ id: "a", kind: "review", branch: "pi/a", worktree: "/rw/review-a-1" }]);
  assert.equal(receipt.cleanup, "recipe-gate abandon '/t/p' --keep 'implement/p'");

  const stray = fake({ review: { "review-a-1": { ...clean, branch: "recipe/r-review-a-1", worktree: "/rw/r-review-a-1", recorded: false } } });
  const strayed = await run(stray.runs, base);
  assert.deepEqual(strayed.left, [{ id: "a", kind: "review", branch: "recipe/r-review-a-1", worktree: "/rw/r-review-a-1" }]);
  assert.equal(
    strayed.cleanup,
    "recipe-gate abandon '/t/p' --keep 'implement/p'; git -C '/r' worktree remove --force '/rw/r-review-a-1'; git -C '/r' branch -D 'recipe/r-review-a-1'",
  );
}

// A dependency that is gone and merged is left out of the tips; the merge is made onto the integration branch.
{
  const back = { ok: true, base: "base0", tasks: { a: { branch: "pi/a", head: null, review: "clean", reviews: 1, review_file: "/t/p/review-a-1.md", merged: true } } };
  const f = fake({ plan: planOf([spec("a"), spec("b", ["a"])]), back });
  await run(f.runs, { ...base, resume: true });
  const c = byKey(f)["deps-b"].gate.command;
  assert.match(c, / --onto 'refs\/heads\/implement\/p'/);
  assert.match(c, / --tips '' /);
  assert.doesNotMatch(c, /pi\/a/);
}

// When every finished task is gone nothing is merged or integrated.
{
  const back = { ok: true, base: "base0", tasks: { a: { branch: "pi/a", head: null, review: "clean", reviews: 1, review_file: "/t/p/review-a-1.md", merged: true } } };
  const f = fake({ back });
  const receipt = await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.equal(k.merge, undefined);
  assert.equal(f.items().filter((i) => i.key.startsWith("integrate")).length, 0);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.branch, "implement/p");
  assert.match(receipt.open[0], /nothing new to integrate/);
}

// A task whose branch is gone runs fresh, or counts as merged when it was tidied.
{
  const back = {
    ok: true,
    base: "base0",
    tasks: {
      a: { branch: "pi/a", head: null, review: "clean", reviews: 1, review_file: "/t/p/review-a-1.md", merged: false },
      b: { branch: "pi/b", head: null, review: "clean", reviews: 1, review_file: "/t/p/review-b-1.md", merged: true },
    },
  };
  const f = fake({ plan: planOf([spec("a"), spec("b")]), back });
  const receipt = await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.equal(k["impl-a"].baseRef, "refs/recipes/p/base");
  assert.equal(k["impl-b"], undefined);
  assert.match(k.merge.gate.command, / --tips 'a:pi\/a'/);
  assert.match(f.items().find((i) => i.key.startsWith("integrate")).gate.command, /--tasks 'a:pi\/a'/);
  assert.deepEqual(receipt.resumed, { done: ["b"], continued: [], answered: [] });
  assert.deepEqual(receipt.merged, ["b", "a"]);
  assert.deepEqual(receipt.open, ["task a: its earlier branch pi/a was gone, so it runs fresh"]);
}

// Reviews of a continued task number on from the earlier ones and the brief names the last.
{
  const back = { ok: true, base: "base0", tasks: { a: { branch: "pi/a", head: "ha", review: "needs-work", reviews: 3, review_file: "/t/p/review-a-3.md", merged: false } } };
  const f = fake({ back });
  await run(f.runs, { ...base, resume: true });
  const k = byKey(f);
  assert.equal(k["review-a-4"].output, "/t/p/review-a-4.md");
  assert.equal(k["review-a-1"], undefined);
  assert.match(k["impl-a"].task, /Earlier review: \/t\/p\/review-a-3\.md/);
  assert.match(k["impl-a"].task, /old worktree may be gone/);
}

// Answers for ids outside the plan are reported, not counted as answered.
{
  const back = { ok: true, base: "base0", tasks: {} };
  const f = fake({ back });
  const receipt = await run(f.runs, { ...base, resume: true, answers: { a: "go", zz: "what" } });
  assert.deepEqual(receipt.resumed.answered, ["a"]);
  assert.deepEqual(receipt.open, ["an answer was given for zz, which is not a task of this plan"]);
}

// Without resume no resume node runs and the receipt lists nothing resumed.
{
  const f = fake();
  const receipt = await run(f.runs, base);
  assert.ok(!keys(f).flat().includes("resume"));
  assert.deepEqual(receipt.resumed, { done: [], continued: [], answered: [] });
}

// An implementer that hands off is relayed: a fresh one starts on its branch with the note.
{
  const f = fake({ impl: { "impl-a": handedOff("a") } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["impl-a-2"], ["review-a-1"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-2"].handoffOf, "run-impl-a");
  assert.equal(k["impl-a-2"].handoffAs, "relay");
  assert.equal(k["impl-a"].handoffOf, undefined);
  assert.match(k["impl-a-2"].task, /^Continue this task from the handoff note at \/t\/p\/impl-a\.md; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assert.match(k["impl-a-2"].gate.command, / --base 'base0' --run '\/t\/p' --id 'a'$/);
  assert.match(k["impl-a-2"].gate.command, /^recipe-gate task '\/t\/p\/impl-a-2\.md'/);
  assert.equal(k["impl-a"].baseRef, "refs/recipes/p/base");
  assert.match(k.integrate.gate.command, /--tasks 'a:pi\/a-2'/);
  assert.deepEqual(receipt.handoffs, [{ id: "a", relays: 1, splits: 0, pieces: [] }]);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.left, [{ id: "a", kind: "relay", branch: "pi/a", worktree: "/wt/a" }]);
  assertUniqueOutputs(f);
}

// A child ended by the valve with commits and no note is relayed from its branch without a note line.
{
  const empty = { result: { ...handedOff("a", { note: null, line: "ended by the context valve before its note" }).result, structuredOutput: { ...handoffGate("a"), reason: "report missing", report: null } } };
  const f = fake({ impl: { "impl-a": empty } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2, 4), [["impl-a"], ["impl-a-2"]]);
  const task = byKey(f)["impl-a-2"].task;
  assert.match(task, /^Continue this task; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assert.doesNotMatch(task, /handoff note/);
  assert.equal(byKey(f)["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.deepEqual(receipt.merged, ["a"]);
}

// The same handoff text through the runner: the port reads the reply and the relay follows.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "implement-handoff-"));
  const args = { plan: dir, repo: "/r" };
  const reply = "handoff: ran out of context\n\nDone: the first half.\nLeft: the second half.";
  const answers = () => ({ impl: { "impl-a": handedOff("a", { note: path.join(dir, "impl-a.md"), finalText: reply }) } });
  const direct = await run(fake(answers()).runs, args);
  const f = fake(answers());
  const through = await runThroughRunner(graph, f.runs, args);
  assert.deepEqual(through, JSON.parse(JSON.stringify(direct)));
  assert.equal(through.handoffs[0].relays, 1);
  assert.match(byKey(f)["impl-a-2"].task, new RegExp("handoff note at " + dir + "/impl-a\\.md;"));
  assert.equal(fs.readFileSync(path.join(dir, "impl-a.md"), "utf8"), reply);
}

// The second handoff with the same head is a split: a planner checked by the plan gate.
// The pieces join the wave of another task, skip review, are joined onto the branch and
// reviewed once; the integration takes the parent and not the pieces.
{
  const answers = {
    plan: planOf([spec("a"), spec("b")]),
    impl: {
      "impl-a": handedOff("a", { line: "first part" }),
      "impl-a-2": handedOff("a-2", { line: "second part", gate: { head: "h" } }),
      "impl-b": handedOff("b", { line: "b one", gate: { head: "hb1" } }),
      "impl-b-2": handedOff("b-2", { line: "b two", gate: { head: "hb2" } }),
    },
  };
  const f = fake(answers);
  const emits = [];
  const receipt = await run(f.runs, base, (v) => emits.push(JSON.parse(JSON.stringify(v))));
  assert.deepEqual(keys(f), [
    ["intake"],
    ["pin"],
    ["impl-a", "impl-b"],
    ["impl-a-2", "impl-b-2"],
    ["split-a-1"],
    ["impl-b-3", "impl-piece-a-1", "impl-piece-a-2"],
    ["join-a-1"],
    ["review-a-1"],
    ["review-b-1"],
    ["merge"],
    ["integrate"],
  ]);
  const k = byKey(f);
  assert.equal(k["split-a-1"].agent, "planner");
  assert.equal(k["split-a-1"].big, true);
  assert.equal(k["split-a-1"].handoffOf, "run-impl-a-2");
  assert.equal(k["split-a-1"].handoffAs, "split");
  assert.equal(k["split-a-1"].output, "/t/p/split/a-1/planner.md");
  assert.equal(k["split-a-1"].gate.command, "recipe-gate plan '/t/p/split/a-1' --repo '/wt/a-2'");
  assert.match(k["split-a-1"].task, /^Task file: \/t\/p\/tasks\/a\.md$/m);
  assert.match(k["split-a-1"].task, /^Handoff note: \/t\/p\/impl-a-2\.md$/m);
  assert.match(k["split-a-1"].task, /git diff base0\.\.pi\/a-2/);
  assert.match(k["split-a-1"].task, /^Files the pieces may own: a\.nix, lib\/a$/m);

  assert.equal(k["impl-piece-a-1"].baseRef, "refs/heads/pi/a-2");
  assert.equal(k["impl-piece-a-1"].worktree, true);
  assert.match(k["impl-piece-a-1"].task, /Task file: \/t\/p\/split\/tasks\/a-1\.md \(read it first\)/);
  assert.match(k["impl-piece-a-1"].gate.command, /--owns 'lib\/a\/a-1' --repo '\/r' --base 'h' --run '\/t\/p' --id 'a-1'$/);

  assert.deepEqual(k["join-a-1"].gate, {
    command:
      "recipe-gate merge '/t/p/split/a-1/join' --dir '/t/p' --branch 'implement/p-split-a-1' --tips 'a-1:pi/a-1,a-2:pi/a-2' --onto 'refs/heads/pi/a-2' --kind task --id a",
    output: "json",
  });
  assert.equal(k["review-a-1"].baseRef, "refs/heads/implement/p-split-a-1");
  assert.match(k["review-a-1"].task, /^Branch: implement\/p-split-a-1$/m);
  assert.match(k["review-a-1"].task, /Diff to review: git diff base0\.\.implement\/p-split-a-1/);
  assert.equal(f.items().filter((i) => /^review-a-1-/.test(i.key) || /^review-piece/.test(i.key)).length, 0);
  assert.match(k.integrate.gate.command, /--tasks 'a:implement\/p-split-a-1,b:pi\/b-3'/);
  assert.match(k.merge.gate.command, /--tips 'a:implement\/p-split-a-1,b:pi\/b-3'/);
  assert.deepEqual(receipt.merged, ["a", "b"]);
  assert.deepEqual(receipt.report, ["a: merged", "  a-1: done, joined into a", "  a-2: done, joined into a", "b: merged"]);
  assert.deepEqual(receipt.handoffs, [
    { id: "a", relays: 1, splits: 1, pieces: ["a-1", "a-2"] },
    { id: "b", relays: 2, splits: 0, pieces: [] },
  ]);
  assert.deepEqual(emits.find((e) => e.stage === "wave 1, round 2").tasks.find((t) => t.id === "a"), { id: "a", state: "split", next: "pieces", fixes: 0, heals: 0, relays: 1, splits: 1 });
  assertUniqueOutputs(f);
}

// Two relays, then the third handoff is a split.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h2" } }),
      "impl-a-3": handedOff("a-3", { line: "three", gate: { head: "h3" } }),
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2, 6), [["impl-a"], ["impl-a-2"], ["impl-a-3"], ["split-a-1"]]);
  assert.match(byKey(f)["split-a-1"].gate.command, /--repo '\/wt\/a-3'/);
  assert.deepEqual(receipt.handoffs, [{ id: "a", relays: 2, splits: 1, pieces: ["a-1", "a-2"] }]);
}

// A successor that spent over half its budget loading context is a split.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h2" }, firstContext: 60000 }),
    },
  });
  await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2, 5), [["impl-a"], ["impl-a-2"], ["split-a-1"]]);
}

// A retry after a relay's successor stopped for a reason of its own starts on the relay branch but is not recorded as a further relay.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a"),
      "impl-a-2": { result: { ok: true, structuredOutput: null } },
    },
    diagnose: { "diagnose-a-1": diagnosis("retry", "the check can be run again") },
  });
  await run(f.runs, base);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].handoffOf, "run-impl-a");
  assert.ok(k["impl-a-3"], "the retry ran");
  assert.equal(k["impl-a-3"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-3"].handoffOf, undefined);
  assert.equal(k["impl-a-3"].handoffAs, undefined);
}

// Two handoffs that ended before their note, on different heads, are two steps of progress, not the same remainder.
{
  const ended = (id, head) => handedOff(id, { note: null, line: "ended by the context valve before its note", gate: { head, reason: "report missing", report: null } });
  const f = fake({ impl: { "impl-a": ended("a", "h1"), "impl-a-2": ended("a-2", "h2") } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2, 5), [["impl-a"], ["impl-a-2"], ["impl-a-3"]]);
  assert.equal(receipt.decide.length, 0);
}


// The same remainder twice is a decision.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "stuck on the same thing", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "Stuck on the same thing!", gate: { head: "h2" } }),
    },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2), [["impl-a"], ["impl-a-2"]]);
  assert.equal(receipt.decide.length, 1);
  assert.equal(receipt.decide[0].id, "a");
  assert.match(receipt.decide[0].question, /the same remainder came back/);
  assert.equal(receipt.set_aside[0].id, "a");
  assert.deepEqual(receipt.left, [{ id: "a", kind: "relay", branch: "pi/a", worktree: "/wt/a" }, { id: "a", kind: "task", branch: "pi/a-2", worktree: "/wt/a-2" }]);
}

// A piece that hands off with nothing committed is a decision, and its parent is set aside.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h1" } }),
      "impl-piece-a-1": handedOff("a-1", { key: "piece-a-1", line: "no progress", gate: { commits: 0 } }),
    },
  });
  const receipt = await run(f.runs, base);
  assert.ok(!keys(f).flat().some((key) => key.startsWith("join-")));
  assert.deepEqual(
    receipt.decide.map((d) => d.id),
    ["a-1"],
  );
  assert.match(receipt.decide[0].question, /nothing committed after a split/);
  assert.deepEqual(
    receipt.set_aside.map((s) => s.id),
    ["a-1", "a"],
  );
  assert.equal(receipt.set_aside[1].reason, "piece a-1 was set aside");
}

// A split whose pieces are not smaller than the task is a decision.
{
  const tooBig = { ...splitPlan(["a-1", "a-2"]), tasks: [piece("a-1", { est: 1000 }), piece("a-2")] };
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h1" } }),
    },
    planner: { "split-a-1": tooBig },
  });
  const receipt = await run(f.runs, base);
  assert.ok(!keys(f).flat().some((key) => key.startsWith("impl-piece")));
  assert.match(receipt.decide[0].question, /piece a-1 is not estimated smaller than the task/);
  assert.equal(receipt.set_aside[0].id, "a");
}

// A third escalation after two splits is a decision.
{
  const small = planOf([piece("a-1-1", { est: 100, owns: ["lib/a/a-1/x"] }), piece("a-1-2", { est: 100, owns: ["lib/a/a-1/y"] })]);
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h1" } }),
      "impl-piece-a-1": handedOff("a-1", { key: "piece-a-1", line: "three", gate: { head: "p1" } }),
      "impl-piece-a-1-2": handedOff("a-1", { key: "piece-a-1-2", line: "four", gate: { head: "p1" } }),
      "impl-piece-a-1-1": handedOff("a-1-1", { key: "piece-a-1-1", line: "five", gate: { head: "q1" } }),
      "impl-piece-a-1-1-2": handedOff("a-1-1", { key: "piece-a-1-1-2", line: "six", gate: { head: "q1" } }),
    },
    planner: { "split-a-1-1": small },
  });
  const receipt = await run(f.runs, base);
  const planners = f.items().filter((i) => i.agent === "planner").map((i) => i.key);
  assert.deepEqual(planners, ["split-a-1", "split-a-1-1"]);
  assert.match(receipt.decide[0].question, /split twice already/);
  assert.equal(receipt.decide[0].id, "a-1-1");
}

// A needs-work verdict on a joined diff starts a fresh implementer on the joined branch with the findings.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h1" } }),
    },
    review: { "review-a-1": needsWork },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(-6), [["join-a-1"], ["review-a-1"], ["impl-a-3"], ["review-a-2"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-3"].baseRef, "refs/heads/implement/p-split-a-1");
  assert.equal(k["impl-a-3"].handoffOf, undefined);
  assert.match(k["impl-a-3"].task, /^Continue this task; the branch implement\/p-split-a-1 holds the committed work/m);
  assert.match(k["impl-a-3"].task, /^The review at \/t\/p\/review-a-1\.md found blocking problems\.$/m);
  assert.equal(f.items().filter((i) => i.resume).length, 0);
  assert.equal(receipt.merged[0], "a");
  assert.match(receipt.report[0], /^a: merged/);
}

// With freshFixes a needs-work verdict goes to a fresh implementer on the task
// branch with the findings, not to the implementer's own session.
{
  const f = fake({ review: { "review-a-1": needsWork } });
  const receipt = await run(f.runs, { ...base, freshFixes: true });
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["impl-a-2"], ["review-a-2"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-2"].resume, undefined);
  assert.equal(k["impl-a-2"].handoffOf, undefined);
  assert.match(k["impl-a-2"].task, /^Continue this task; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assert.match(k["impl-a-2"].task, /^The review at \/t\/p\/review-a-1\.md found blocking problems\.$/m);
  assert.equal(f.items().filter((i) => i.resume).length, 0);
  assert.equal(receipt.fresh_fixes, true);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.children, 8);
}

// Without freshFixes the needs-work verdict resumes the implementer's session,
// and the receipt carries no fresh-fixes marker.
{
  const f = fake({ review: { "review-a-1": needsWork } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["fix-a-1"], ["review-a-2"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["fix-a-1"].resume, "run-impl-a");
  assert.match(k["fix-a-1"].task, /^The review at \/t\/p\/review-a-1\.md found blocking problems\.$/m);
  assert.equal(receipt.fresh_fixes, undefined);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.children, 8);
}

// A joined diff that stays needs-work goes to a decision once the fixes are used up.
{
  const f = fake({
    impl: {
      "impl-a": handedOff("a", { line: "one", gate: { head: "h1" } }),
      "impl-a-2": handedOff("a-2", { line: "two", gate: { head: "h1" } }),
    },
    review: { "review-a-1": needsWork, "review-a-2": needsWork, "review-a-3": needsWork },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(-7), [["join-a-1"], ["review-a-1"], ["impl-a-3"], ["review-a-2"], ["fix-a-2"], ["review-a-3"], ["diagnose-a-1"]]);
  assert.equal(f.items().find((i) => i.key === "fix-a-2").resume, "run-impl-a-3");
  assert.equal(receipt.decide[0].id, "a");
  assert.match(byKey(f)["diagnose-a-1"].task, /still not clean after 2 fix rounds/);
}

// A fix round that hands off: the task gate runs once on its note for the head, then a relay starts with the findings.
{
  const f = fake({
    review: { "review-a-1": needsWork },
    fix: { "fix-a-1": { result: { ok: true, handoff: { line: "handoff: half the fix", unread: [], note: "/t/p/fix-a-1.md", empty: false }, usage: { firstContext: 1000 }, budget: { tokens: 100000 } } } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2), [["impl-a"], ["review-a-1"], ["fix-a-1"], ["handoff-a-1"], ["impl-a-2"], ["review-a-2"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["handoff-a-1"].agent, "scout");
  assert.equal(
    k["handoff-a-1"].gate.command,
    "recipe-gate task '/t/p/fix-a-1.md' --check 'nixfmt --check a.nix' --owns 'a.nix,lib/a' --repo '/r' --base 'base0' --run '/t/p' --id 'a'",
  );
  assert.equal(k["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-2"].handoffOf, "run-fix-a-1");
  assert.equal(k["impl-a-2"].handoffAs, "relay");
  assert.match(k["impl-a-2"].task, /^Continue this task from the handoff note at \/t\/p\/fix-a-1\.md; the branch pi\/a holds/m);
  assert.match(k["impl-a-2"].task, /^The review at \/t\/p\/review-a-1\.md found blocking problems\.$/m);
  assert.equal(receipt.handoffs[0].relays, 1);
  assert.deepEqual(receipt.merged, ["a"]);
}

// A resolver that hands off is not relayed; the merge gate decides.
{
  const handingOff = { result: { ...handedOff("b", { line: "resolver half done" }).result, structuredOutput: conflictAt("integration", "b") } };
  const f = fake({
    plan: planOf([spec("a"), spec("b")]),
    merge: { merge: conflictAt("integration", "b"), "resolve-integration-1": handingOff },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(-2), [["merge"], ["resolve-integration-1"]]);
  assert.equal(receipt.decide.length, 1);
  assert.equal(receipt.decide[0].id, "integration");
  assert.match(receipt.decide[0].question, /left as it was by the resolver/);
}

// A stop while an implementer runs ends the graph without a set-aside task or a receipt.
{
  const f = fake({ impl: { "impl-a": { result: { ok: false, status: "aborted", error: "run stopped" } } } });
  await assert.rejects(run(f.runs, base), { name: "RunStopped" });
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"]]);
}

console.log("implement graph: ok");
