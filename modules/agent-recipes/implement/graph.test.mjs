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
const clean = { ok: true, verdict: "clean", reason: "", check: { command: "c", exit: 0, tail: "" }, reproduced: [], unreproduced: [], unrunnable: [], findings: 0, quotes_missing: [], tried: null, claimed: [] };
const needsWork = {
  ...clean,
  verdict: "needs-work",
  reproduced: [{ n: 1, kind: "sh", title: "B1. off by one", summary: "sh t.sh", exit: 1, tail: "FAIL" }],
  unreproduced: [{ n: 2, kind: "diff", title: "B2. unchecked", summary: "a.nix", exit: 1, tail: "" }],
  findings: 2,
};
const survivors = {
  ...clean,
  verdict: "needs-work",
  findings: 2,
  tried: 5,
  reproduced: [
    { n: 1, kind: "diff", title: "Survivor 1: a.nix:3", summary: "a.nix", exit: 0, tail: "" },
    { n: 2, kind: "diff", title: "Survivor 2: lib/a/x", summary: "lib/a/x", exit: 0, tail: "" },
  ],
};
const noMutation = { tried: null, survived: 0, confirmed: 0, fixed: 0, equivalent: 0, claims: [] };
const assertFindingsBrief = (task) => {
  assert.match(task, /^The review at \/t\/p\/review-a-1\.md showed these defects at the branch head\./m);
  assert.match(task, /^1\. \[B1\. off by one\] sh t\.sh -> exit 1$/m);
  assert.match(task, /^FAIL$/m);
  assert.match(task, /^Advice from the review, not required: B2\. unchecked: a\.nix$/m);
  assert.doesNotMatch(task, /found blocking problems/);
};
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

function fake({ plan = planOf([spec("a")]), pin = pinGate, back = undefined, intake = {}, impl = {}, review = {}, mutate = {}, recheck = {}, final = {}, integrate = {}, diagnose = {}, merge = {}, planner = {} } = {}) {
  const batches = [];
  const answer = (table, key, fallback) => {
    const given = key in table ? table[key] : fallback;
    if (given && given.result) return { runId: `run-${key}`, ...given.result };
    return typeof given === "string" ? failed(key, given) : ok(key, given);
  };
  const idOf = (key) => (key.startsWith("impl-piece-") ? key.replace(/^impl-piece-/, "") : key.replace(/^impl-/, "").replace(/-\d+(-retry)?$/, "")).replace(/-retry$/, "");
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
      final_check: (item.gate.command.match(/ --final '([^']*)'$/) || [])[1] ?? "pass",
      pr_text: "PR text",
    };
  };
  return {
    batches,
    items: () => batches.flat(),
    runs: {
      all: async (items) => {
        batches.push(items);
        for (const i of items) assert.equal(i.maxRuntimeMs, undefined, i.key);
        return items.map((item) => {
          switch (item.agent) {
            case null:
              if (item.key.startsWith("pin")) return answer({}, item.key, pin);
              if (item.key.startsWith("resume")) return answer({}, item.key, back);
              if (item.key.startsWith("final-")) return answer(final, item.key, { ok: true });
              if (item.key.startsWith("recheck-")) return answer(recheck, item.key, clean);
              if (/^(deps-|merge|join-)/.test(item.key)) return answer(merge, item.key, mergeGate(item));
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
            case "mutator":
              return answer(mutate, item.key, { ...clean, branch: `pi/${item.key.replace(/^mutate-/, "").replace(/-retry$/, "")}`, worktree: `/mw/${item.key}` });
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
    ["mutate-a"],
    ["impl-b-2", "impl-c-2"],
    ["review-b-2"],
    ["review-c-2"],
    ["mutate-b"],
    ["impl-c-3"],
    ["review-c-3"],
    ["diagnose-c-1"],
    ["deps-d"],
    ["impl-d"],
    ["review-d-1"],
    ["mutate-d"],
    ["merge"],
    ["integrate"],
  ]);
  const k = byKey(f);

  assert.equal(k.intake.agent, null);
  assert.deepEqual(k.intake.gate, { command: "recipe-gate plan '/t/p' --repo '/r'", output: "json" });

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

  assert.equal(k.pin.agent, null);
  assert.deepEqual(k.pin.gate, { command: "recipe-gate pin '/t/p' --repo '/r'", output: "json" });

  assert.equal(k["deps-d"].agent, null);
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

  assert.equal(k.merge.agent, null);
  for (const gateOnly of [k.intake, k.pin, k["deps-d"], k.merge]) {
    assert.equal(gateOnly.task, undefined);
    assert.equal(gateOnly.output, undefined);
    assert.equal(gateOnly.outputMode, undefined);
  }
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
  assert.deepEqual(k["review-b-1"].gate, {
    command: "recipe-gate findings '/t/p/review-b-1.md' --check 'nixfmt --check b.nix' --run '/t/p' --id 'b'",
    output: "json",
    timeoutMs: 6600000,
  });
  assert.match(k["review-b-1"].task, /^Review a diff on a branch \(the diff variant\)\.$/m);
  assert.match(k["review-b-1"].task, /Branch: pi\/b/);
  assert.match(k["review-b-1"].task, /Worktree: your working directory is your own worktree of the branch; .*make no other worktree\. The implementer.s worktree \/wt\/b is not yours/);
  assert.equal(k["review-b-1"].worktree, true);
  assert.equal(k["review-b-1"].baseRef, "refs/heads/pi/b");
  assert.equal(k["review-b-1"].big, true);
  assert.equal(k.integrate.big, undefined);
  assert.match(k["review-b-1"].task, /Diff to review: git diff base0..pi\/b/);
  assert.match(k["review-b-1"].task, /Check to run: nixfmt --check b\.nix/);
  assert.doesNotMatch(k["review-b-1"].task, /Implementer report/);
  assert.doesNotMatch(k["review-b-1"].task, /Earlier review/);
  assert.doesNotMatch(k["review-b-2"].task, /re-review/);
  assert.doesNotMatch(k["review-b-2"].task, /Earlier review/);
  assert.match(k["review-b-2"].task, /^Review a diff on a branch \(the diff variant\)\./m);

  assert.equal(k["impl-b-2"].agent, "implementer");
  assert.equal(k["impl-b-2"].resume, undefined);
  assert.equal(k["impl-b-2"].handoffOf, undefined);
  assert.equal(k["impl-b-2"].worktree, true);
  assert.equal(k["impl-b-2"].baseRef, "refs/heads/pi/b");
  assert.match(k["impl-b-2"].gate.command, /^recipe-gate task '\/t\/p\/impl-b-2\.md'/);
  assert.equal(k["impl-b-2"].output, "/t/p/impl-b-2.md");
  assert.match(k["impl-b-2"].task, /^Continue this task; the branch pi\/b holds the committed work, so build on it and do not redo it\.$/m);
  assert.match(k["impl-b-2"].task, /The review at \/t\/p\/review-b-1\.md showed these defects at the branch head\./);
  assert.match(k["impl-b-2"].task, /^1\. \[B1\. off by one\] sh t\.sh -> exit 1$/m);
  assert.equal(k["impl-c-3"].resume, undefined);
  assert.equal(f.items().filter((i) => i.resume).length, 0);

  assert.equal(k.integrate.agent, "implementer");
  assert.equal(k.integrate.worktree, false);
  assert.equal(k.integrate.output, "/t/p/integration.md");
  assert.deepEqual(k.integrate.gate, {
    command: "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,d:pi/d' --branch 'implement/p' --tidy yes --final 'none'",
    output: "json",
  });
  assert.match(k.integrate.task, /Finished tasks, as id:branch: a:pi\/a,b:pi\/b,d:pi\/d/);
  assert.match(k.integrate.task, /Integration worktree: \/t\/p\/integration \(already made/);
  assert.match(k.integrate.task, /Create no worktree and merge nothing/);
  for (const item of f.items().filter((i) => i.task !== undefined)) assert.doesNotMatch(item.task, /git merge|git worktree add/);
  assert.doesNotMatch(k.integrate.task, /Write \/t\/p\/(?!pr\.md)/);
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
  assert.match(k["diagnose-c-1"].task, /Evidence: \/t\/p\/review-c-3\.md, \/t\/p\/impl-c-3\.md/);
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
    mutations: { a: noMutation, b: noMutation, d: noMutation },
    final_check: "none",
    healed: [],
    decide: [{ id: "c", step: "review", question: "a person has to choose", diagnosis: "/t/p/diagnosis-c-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: [],
    left: [{ id: "c", kind: "task", branch: "pi/c", worktree: "/wt/c" }],
    cleanup: "recipe-gate abandon '/t/p' --keep 'implement/p'",
    children: 19,
    pr_text: "PR text",
  });
}

// The plan's final checks run in the integration worktree before the integrator, and their verdict rides on the integrate gate.
{
  const finals = { ...planOf([spec("a")]), final_checks: ["nix flake check", "make test"] };
  const passing = fake({ plan: finals });
  await run(passing.runs, base);
  assert.deepEqual(keys(passing).slice(-3), [["final-1"], ["final-2"], ["integrate"]]);
  assert.equal(byKey(passing)["final-1"].big, true);
  assert.equal(byKey(passing)["final-1"].agent, null);
  assert.match(byKey(passing)["final-1"].gate.command, /--command 'nix flake check' /);
  assert.match(byKey(passing)["final-2"].gate.command, /--command 'make test' /);
  assert.match(byKey(passing).integrate.gate.command, / --final 'pass'$/);

  const failing = fake({ plan: finals, final: { "final-2": { ok: false, reason: "exit 2" } } });
  await run(failing.runs, base);
  assert.match(byKey(failing).integrate.gate.command, / --final 'fail: make test: exit 2'$/);

  const broken = fake({ plan: finals, integrate: { integrate: "boom", "integrate-retry": "boom" } });
  await run(broken.runs, base);
  assert.match(byKey(broken)["diagnose-integration-1"].task, /^Evidence: \/t\/p\/integration\.retry\.md, \/t\/p\/final-1\.log, \/t\/p\/final-2\.log$/m);

  const none = fake();
  await run(none.runs, base);
  assert.equal(none.items().some((i) => i.key.startsWith("final-")), false);
  assert.match(byKey(none).integrate.gate.command, / --final 'none'$/);
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
    mutations: {},
    final_check: null,
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
    children: 0,
    pr_text: "",
  });
}

// A plan gate that does not run ends the run; gate-only steps are not retried.
{
  const f = fake({ intake: { intake: "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"]]);
  assert.deepEqual(receipt.open, ["the plan check did not run: 503"]);
  assert.equal(receipt.children, 0);
  assert.equal(receipt.branch, null);
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
    mutations: {},
    final_check: null,
    healed: [],
    decide: [{ id: "a", step: "implement", question: "a person has to choose", diagnosis: "/t/p/diagnosis-a-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["impl-a-2"], ["review-a-1"], ["mutate-a"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].resume, undefined);
  assert.match(k["impl-a-2"].task, /The task check reported: check failed \(exit 1\): red/);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a", "impl-b"], ["impl-a-retry"], ["review-b-1"], ["mutate-b"], ["diagnose-a-1"], ["merge"], ["integrate"]]);
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
  assert.equal(receipt.children, 7);
}

// An implementer that fails once and then succeeds is reviewed from its retry.
{
  const f = fake({ impl: { "impl-a": "503" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["impl-a-retry"], ["review-a-1"], ["mutate-a"], ["merge"], ["integrate"]]);
  assert.doesNotMatch(byKey(f)["review-a-1"].task, /Implementer report/);
  assert.deepEqual(receipt.set_aside, []);
}

// A fix that fails twice goes to a diagnosis; the retry is a fresh run too.
{
  const f = fake({
    review: { "review-a-1": needsWork },
    impl: { "impl-a-2": "x", "impl-a-2-retry": "x" },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["impl-a-2"], ["impl-a-2-retry"], ["diagnose-a-1"]]);
  assert.equal(f.batches[5][0].resume, undefined);
  assert.equal(f.batches[5][0].output, "/t/p/impl-a-2.retry.md");
  assertUniqueOutputs(f);
  assert.match(byKey(f)["diagnose-a-1"].task, /What went wrong: the implementer failed twice: x/);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
  assert.equal(receipt.children, 5);
}

// A reviewer that fails twice goes to a diagnosis that may retry it.
{
  const f = fake({ review: { "review-a-1": "boom", "review-a-1-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["review-a-1-retry"], ["diagnose-a-1"]]);
  assert.deepEqual(f.batches[4][0].gate, {
    command: "recipe-gate findings '/t/p/review-a-1.retry.md' --check 'nixfmt --check a.nix' --run '/t/p' --id 'a'",
    output: "json",
    timeoutMs: 6600000,
  });
  assert.match(byKey(f)["diagnose-a-1"].gate.command, / --allow 'retry,decide'$/);
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "needs a decision: a person has to choose" }]);
}

// A review with no verdict goes to a diagnosis that may only retry or decide.
{
  const f = fake({ review: { "review-a-1": { ...clean, ok: false, verdict: null, reason: "worktree not clean" } } });
  await run(f.runs, base);
  assert.equal(byKey(f)["diagnose-a-1"].gate.command, "recipe-gate diagnosis '/t/p/diagnosis-a-1.md' --allow 'retry,decide'");
  assert.doesNotMatch(byKey(f)["diagnose-a-1"].task, /With continue/);
}

// A diagnosis cannot answer continue for a review: the gate rejects it and the task goes to a person.
{
  const f = fake({
    review: { "review-a-1": { ...clean, ok: false, verdict: null, reason: "worktree not clean" } },
    diagnose: { "diagnose-a-1": { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false, problem: "action continue is not allowed" } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["diagnose-a-1"]]);
  assert.equal(byKey(f)["diagnose-a-1"].gate.command, "recipe-gate diagnosis '/t/p/diagnosis-a-1.md' --allow 'retry,decide'");
  assert.equal(receipt.decide.length, 1);
  assert.equal(receipt.decide[0].step, "review");
  assert.deepEqual(receipt.merged, []);
}

// A failed check with no reproduced finding is the fix brief's first item.
{
  const f = fake({ review: { "review-a-1": { ...clean, verdict: "needs-work", check: { command: "c", exit: 1, tail: "boom" } } } });
  await run(f.runs, base);
  const task = byKey(f)["impl-a-2"].task;
  assert.match(task, /^1\. The task's check failed at head -> exit 1$/m);
  assert.match(task, /^boom$/m);
  assert.doesNotMatch(task, /^2\. /m);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["mutate-a"], ["deps-b"], ["impl-b"], ["diagnose-b-1"], ["impl-b-2"], ["review-b-1"], ["mutate-b"], ["merge"], ["integrate"]]);
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
    ["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["impl-a-2"], ["review-a-2"], ["impl-a-3"], ["review-a-3"], ["diagnose-a-1"], ["impl-a-4"], ["review-a-4"], ["mutate-a"], ["merge"], ["integrate"],
  ]);
  const k = byKey(f);
  assert.match(k["impl-a-4"].task, /^Continue this task; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assert.match(k["impl-a-4"].task, /The diagnosis at \/t\/p\/diagnosis-a-1\.md found: the test asserts the old flag order Follow its ## Brief section\./);
  assert.equal(k["impl-a-4"].resume, undefined);
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
  assert.doesNotMatch(byKey(f)["diagnose-a-2"].task, /Earlier diagnosis/);
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
    review: { "review-a-1": { ...clean, ok: false, verdict: null, reason: "worktree not clean" } },
    diagnose: { "diagnose-a-1": { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false, problem: "no action line" } },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.decide, [
    { id: "a", step: "review", question: "the review gave no verdict: worktree not clean; the diagnosis could not be read: no action line", diagnosis: "/t/p/diagnosis-a-1.md" },
  ]);
}

// An integration the gate does not accept is diagnosed and run once more.
{
  const f = fake({
    integrate: { integrate: { ok: false, reasons: ["not merged: a"], branch: "implement/p", head: "h", merged: [], unmerged: ["a"], clean: true, final_check: "none", pr_text: "" } },
    diagnose: { "diagnose-integration-1": diagnosis("retry", "the merge stopped on a conflict it can resolve") },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["mutate-a"], ["merge"], ["integrate"], ["diagnose-integration-1"], ["integrate-2"]]);
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
  assert.deepEqual(emits[1].tasks[0], { id: "a", state: "running", next: "implement", fixes: 1, heals: 0 });
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
      "impl-a-2": { result: { ok: false, error: rejected } },
    },
    diagnose: { "diagnose-b-1": diagnosis("decide", "what port?") },
  });
  const receipt = await run(f.runs, base);
  assert.equal(f.items().filter((i) => /-retry$/.test(i.key)).length, 0);
  const k = byKey(f);
  assert.match(k["diagnose-b-1"].task, /What went wrong: the implementer reported blocked: report blocked: needs the port/);
  assert.match(k["diagnose-a-1"].task, /What went wrong: the implementer failed twice: Acceptance rejected/);
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
    ["mutate-a"],
    ["deps-b"],
    ["impl-b"],
    ["review-b-1"],
    ["mutate-b"],
    ["deps-c"],
    ["impl-c"],
    ["review-c-1"],
    ["mutate-c"],
    ["merge"],
    ["integrate"],
  ]);
  assert.match(byKey(f)["impl-b"].task, /: a \(branch pi\/a\)\. Do not merge anything\./);
  assert.match(byKey(f)["impl-c"].task, /: b \(branch pi\/b\)\. Do not merge anything\./);
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a,b:pi/b,c:pi/c' --branch 'implement/p' --tidy yes --final 'none'");
  assert.match(byKey(f).merge.gate.command, / --tips 'c:pi\/c' /);
  assert.deepEqual(receipt.merged, ["a", "b", "c"]);
}

// An integration that fails twice leaves the finished branches in the receipt.
{
  const f = fake({ integrate: { integrate: "boom", "integrate-retry": "boom" } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["mutate-a"], ["merge"], ["integrate"], ["integrate-retry"], ["diagnose-integration-1"]]);
  assert.equal(f.batches[7][0].output, "/t/p/integration.retry.md");
  assert.match(byKey(f)["diagnose-integration-1"].gate.command, / --allow 'retry,decide'$/);
  assert.match(byKey(f)["diagnose-integration-1"].task, /^Evidence: \/t\/p\/integration\.retry\.md$/m);
  assert.equal(f.batches[7][0].gate.command, f.batches[6][0].gate.command);
  assertUniqueOutputs(f);
  assert.deepEqual(receipt, {
    base: "base0",
    left: [
      { id: "a", kind: "task", branch: "pi/a", worktree: "/wt/a" },
      { id: "a", kind: "review", branch: "pi/a", worktree: "/rw/review-a-1" },
      { id: "a", kind: "review", branch: "pi/a", worktree: "/mw/mutate-a" },
      { id: "integration", kind: "integration", branch: "implement/p", worktree: "/t/p/integration" },
    ],
    cleanup: "recipe-gate abandon '/t/p'",
    branch: null,
    merged: [],
    set_aside: [],
    skipped: [],
    report: ["a: not merged"],
    mutations: { a: noMutation },
    final_check: "none",
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
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
        reasons: ["not merged: b", "final checks: fail: red"],
        branch: "implement/p",
        head: "h",
        merged: ["a"],
        unmerged: ["b"],
        clean: true,
        final_check: "fail: red",
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
      { id: "a", kind: "review", branch: "pi/a", worktree: "/mw/mutate-a" },
      { id: "b", kind: "review", branch: "pi/b", worktree: "/mw/mutate-b" },
      { id: "integration", kind: "integration", branch: "implement/p", worktree: "/t/p/integration" },
    ],
    cleanup: "recipe-gate abandon '/t/p'",
    branch: "implement/p",
    merged: ["a"],
    set_aside: [],
    skipped: [],
    report: ["a: merged", "b: not merged"],
    mutations: { a: noMutation, b: noMutation },
    final_check: "fail: red",
    healed: [],
    decide: [{ id: "integration", step: "integrate", question: "a person has to choose", diagnosis: "/t/p/diagnosis-integration-1.md" }],
    resumed: { done: [], continued: [], answered: [] },
    open: ["integration: not merged: b", "integration: final checks: fail: red"],
    children: 8,
    pr_text: "PR",
  });
}

// A task worktree the cleanup could not remove is reported, the run still ends well.
{
  const f = fake({
    integrate: {
      integrate: {
        ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true,
        final_check: "none", pr_text: "PR", tidied: [], tidy_problems: ["a: worktree /wt/a kept: contains untracked files"],
      },
    },
  });
  const receipt = await run(f.runs, base);
  assert.match(byKey(f).integrate.gate.command, / --tidy yes --final 'none'$/);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, ["cleanup: a: worktree /wt/a kept: contains untracked files"]);
}

// An integration with no result from the gate names the branches.
{
  const f = fake({ integrate: { integrate: undefined } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.open, ["the integration check did not run; finished branches: a:pi/a"]);
  assert.ok(!f.items().some((i) => i.key.startsWith("diagnose-")), "no diagnosis for an unrun gate");
}

// A task gate that did not run sets the task aside without a diagnosis.
{
  const f = fake({ impl: { "impl-a": undefined } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: the task check did not run"));
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "task a: the task check did not run" }]);
  assert.deepEqual(receipt.merged, []);
  assert.ok(!f.items().some((i) => i.key.startsWith("diagnose-")), "no diagnosis for an unrun gate");
}

// A review verdict gate that did not run sets the task aside without a diagnosis.
{
  const f = fake({ review: { "review-a-1": undefined } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: the review's verdict gate did not run"));
  assert.deepEqual(receipt.set_aside, [{ id: "a", reason: "task a: the review's verdict gate did not run" }]);
  assert.deepEqual(receipt.merged, []);
  assert.ok(!f.items().some((i) => i.key.startsWith("diagnose-")), "no diagnosis for an unrun gate");
}

// The branch argument names the integration branch.
{
  const f = fake();
  const receipt = await run(f.runs, { ...base, branch: "feature/x" });
  assert.equal(byKey(f).integrate.gate.command, "recipe-gate integrate '/t/p' --tasks 'a:pi/a' --branch 'feature/x' --tidy yes --final 'none'");
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
  assert.match(k.integrate.gate.command, / --branch 'implement\/it-s' --tidy yes --final 'none'$/);
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
  assert.equal(receipt.children, 0);

  const g = fake({ pin: "boom" });
  const failedPin = await run(g.runs, base);
  assert.deepEqual(keys(g), [["intake"], ["pin"]]);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a", "impl-b"], ["review-a-1"], ["review-b-1"], ["mutate-a", "mutate-b"], ["merge"], ["resolve-integration-1"], ["integrate"]]);
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
  for (const item of f.items().filter((i) => i.task !== undefined)) assert.doesNotMatch(item.task, /git merge|git worktree add/, item.key);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["mutate-a"], ["deps-b"], ["resolve-b-1"], ["merge"], ["integrate"]]);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["mutate-a"], ["deps-b"], ["resolve-b-1"], ["impl-b"], ["review-b-1"], ["mutate-b"], ["merge"], ["integrate"]]);
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
  assert.equal(k.resume.agent, null);
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
  const gateOut = { ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true, final_check: "pass", pr_text: "PR", left_over };
  const stuck = fake({ integrate: { integrate: gateOut } });
  const receipt = await run(stuck.runs, base);
  assert.deepEqual(receipt.left, [
    { id: "a", kind: "review", branch: "pi/a", worktree: "/rw/review-a-1" },
    { id: "a", kind: "review", branch: "pi/a", worktree: "/mw/mutate-a" },
  ]);
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
  assert.doesNotMatch(k["impl-a"].task, /Earlier review/);
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
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["impl-a-2"], ["review-a-1"], ["mutate-a"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-2"].handoffOf, "run-impl-a");
  assert.equal(k["impl-a-2"].handoffAs, "relay");
  assert.equal(k["impl-a"].handoffOf, undefined);
  assert.match(k["impl-a-2"].task, /^Continue this task from the handoff note at \/t\/p\/impl-a\.md; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assert.match(k["impl-a-2"].gate.command, / --base 'base0' --run '\/t\/p' --id 'a'$/);
  assert.match(k["impl-a-2"].gate.command, /^recipe-gate task '\/t\/p\/impl-a-2\.md'/);
  assert.equal(k["impl-a"].baseRef, "refs/recipes/p/base");
  assert.match(k.integrate.gate.command, /--tasks 'a:pi\/a'/);
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
    ["mutate-a", "mutate-b"],
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
  assert.match(k.integrate.gate.command, /--tasks 'a:implement\/p-split-a-1,b:pi\/b'/);
  assert.match(k.merge.gate.command, /--tips 'a:implement\/p-split-a-1,b:pi\/b'/);
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
      "impl-a-2": { ...taskGate("a-2"), ok: false, reason: "blocked: x", report: { status: "blocked", why: "x" } },
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
  assert.deepEqual(keys(f).slice(-7), [["join-a-1"], ["review-a-1"], ["impl-a-3"], ["review-a-2"], ["mutate-a"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-3"].baseRef, "refs/heads/implement/p-split-a-1");
  assert.equal(k["impl-a-3"].handoffOf, undefined);
  assert.match(k["impl-a-3"].task, /^Continue this task; the branch implement\/p-split-a-1 holds the committed work/m);
  assertFindingsBrief(k["impl-a-3"].task);
  assert.equal(f.items().filter((i) => i.resume).length, 0);
  assert.equal(receipt.merged[0], "a");
  assert.match(receipt.report[0], /^a: merged/);
}

// A needs-work verdict goes to a fresh implementer on the task branch with
// the findings; no run is ever resumed.
{
  const f = fake({ review: { "review-a-1": needsWork } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"], ["review-a-1"], ["impl-a-2"], ["review-a-2"], ["mutate-a"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-2"].agent, "implementer");
  assert.equal(k["impl-a-2"].worktree, true);
  assert.equal(k["impl-a-2"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-2"].resume, undefined);
  assert.equal(k["impl-a-2"].handoffOf, undefined);
  assert.match(k["impl-a-2"].task, /^Continue this task; the branch pi\/a holds the committed work, so build on it and do not redo it\.$/m);
  assertFindingsBrief(k["impl-a-2"].task);
  assert.equal(f.items().filter((i) => i.resume).length, 0);
  assert.equal(receipt.fresh_fixes, undefined);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.equal(receipt.children, 6);
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
  assert.deepEqual(keys(f).slice(-7), [["join-a-1"], ["review-a-1"], ["impl-a-3"], ["review-a-2"], ["impl-a-4"], ["review-a-3"], ["diagnose-a-1"]]);
  assert.equal(f.items().find((i) => i.key === "impl-a-4").resume, undefined);
  assert.equal(receipt.decide[0].id, "a");
  assert.match(byKey(f)["diagnose-a-1"].task, /still not clean after 2 fix rounds/);
}

// A fix round that hands off: the implementer path relays it with the findings still in the brief.
{
  const f = fake({
    review: { "review-a-1": needsWork },
    impl: { "impl-a-2": handedOff("a", { line: "half the fix", key: "a-2" }) },
  });
  const receipt = await run(f.runs, base);
  assert.deepEqual(keys(f).slice(2), [["impl-a"], ["review-a-1"], ["impl-a-2"], ["impl-a-3"], ["review-a-2"], ["mutate-a"], ["merge"], ["integrate"]]);
  const k = byKey(f);
  assert.equal(k["impl-a-3"].baseRef, "refs/heads/pi/a");
  assert.equal(k["impl-a-3"].handoffOf, "run-impl-a-2");
  assert.equal(k["impl-a-3"].handoffAs, "relay");
  assert.match(k["impl-a-3"].task, /^Continue this task from the handoff note at \/t\/p\/impl-a-2\.md; the branch pi\/a holds/m);
  assertFindingsBrief(k["impl-a-3"].task);
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

// The mutation step: a node of its own after each clean first review, a counted fix round for
// survivors, a gate-only re-check, and a fresh review.
{
  const f = fake();
  await run(f.runs, base);
  const m = byKey(f)["mutate-a"];
  assert.equal(m.agent, "mutator");
  assert.equal(m.worktree, true);
  assert.equal(m.baseRef, "refs/heads/pi/a");
  assert.equal(m.big, undefined);
  assert.equal(m.output, "/t/p/mutations-a.md");
  assert.equal(m.gate.command, "recipe-gate findings '/t/p/mutations-a.md' --check 'nixfmt --check a.nix' --run '/t/p' --id 'a'");
  assert.equal(m.gate.timeoutMs, 6600000);
  assert.match(m.task, /^Diff range: base0\.\.pi\/a \(run git diff base0\.\.pi\/a\)$/m);
  assert.match(m.task, /^Owned files: a\.nix, lib\/a$/m);
  assert.match(m.task, /^Check: nixfmt --check a\.nix$/m);
  assertUniqueOutputs(f);
}

const mutationFixed = {
  mutate: { "mutate-a": survivors },
  recheck: {
    "recheck-a": {
      ...clean,
      unreproduced: [{ n: 1, kind: "diff", title: "Survivor 1: a.nix:3", summary: "a.nix", exit: 1, tail: "" }],
      claimed: [{ n: 2, reason: "dead constant" }],
    },
  },
};

// Survivors are fixed or claimed equivalent.
{
  const f = fake(mutationFixed);
  const emits = [];
  const receipt = await run(f.runs, base, (v) => emits.push(JSON.parse(JSON.stringify(v))));
  assert.deepEqual(f.items().map((i) => i.key).filter((x) => x !== "intake" && x !== "pin").slice(0, 6), ["impl-a", "review-a-1", "mutate-a", "impl-a-2", "recheck-a", "review-a-2"]);
  assert.equal(f.items().filter((i) => i.key === "mutate-a").length, 1);
  const k = byKey(f);
  assert.match(k["impl-a-2"].task, /found changed code the check does not cover/);
  assert.match(k["impl-a-2"].task, /^Check: nixfmt --check a\.nix$/m);
  assert.match(k["impl-a-2"].task, /^1\. \[Survivor 1: a\.nix:3\] patch to a\.nix$/m);
  assert.match(k["impl-a-2"].task, /^2\. \[Survivor 2: lib\/a\/x\] patch to lib\/a\/x$/m);
  assert.match(k["impl-a-2"].task, /## Equivalent <n>/);
  assert.match(k["impl-a-2"].task, /never add a test that pins the wording/);
  assert.equal(k["recheck-a"].agent, null);
  assert.equal(k["recheck-a"].worktree, true);
  assert.equal(k["recheck-a"].baseRef, "refs/heads/pi/a");
  assert.equal(k["recheck-a"].gate.command, "recipe-gate findings '/t/p/mutations-a.md' --check 'nixfmt --check a.nix' --claims '/t/p/impl-a-2.md' --run '/t/p' --id 'a'");
  assert.equal(k["recheck-a"].gate.timeoutMs, 6600000);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.mutations, { a: { tried: 5, survived: 2, confirmed: 2, fixed: 1, equivalent: 1, claims: [{ n: 2, reason: "dead constant" }] } });
  assert.deepEqual(receipt.open, []);
  const rows = emits.filter((e) => e.tasks).map((e) => e.tasks.find((t) => t.id === "a"));
  assert.equal(rows[rows.length - 1].fixes, 1);
  assertUniqueOutputs(f);
}

// The re-check's worktree is recorded by its gate, so the tidy removes it and it is not left behind;
// one the gate could not record is left, with a command that removes it.
{
  const rechecked = (extra) => ({ recheck: { "recheck-a": { result: { ok: true, worktree: "/cw/recheck-a", branch: "pi/a", structuredOutput: { ...mutationFixed.recheck["recheck-a"], branch: "pi/a", worktree: "/cw/recheck-a", ...extra } } } } });
  const f = fake({ ...mutationFixed, ...rechecked({}), integrate: { integrate: { ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true, final_check: "pass", pr_text: "PR", left_over: [] } } });
  const receipt = await run(f.runs, base);
  assert.equal(receipt.left.some((l) => l.worktree === "/cw/recheck-a"), false);

  const g = fake({ ...mutationFixed, ...rechecked({ recorded: false }) });
  const stray = await run(g.runs, base);
  assert.ok(stray.left.some((l) => l.worktree === "/cw/recheck-a"));
  assert.match(stray.cleanup, /worktree remove --force '\/cw\/recheck-a'/);
}

// A merged task's kept attempts are listed only while the gate still lists them as task entries.
{
  const integrate = (left_over) => ({ integrate: { ok: true, reasons: [], branch: "implement/p", head: "h", merged: ["a"], unmerged: [], clean: true, final_check: "pass", pr_text: "PR", left_over } });
  const attempts = (left_over) => fake({
    review: { "review-a-1": needsWork },
    impl: { "impl-a-2": { ...taskGate("a"), branch: "pi/a-2", worktree: "/wt/a-2" } },
    integrate: integrate(left_over),
  });
  const tasksOf = (r) => r.left.filter((l) => l.kind === "task" && l.id === "a");

  const none = await run(attempts([]).runs, base);
  assert.deepEqual(tasksOf(none), []);

  const entry = { kind: "task", id: "a", branch: "pi/a", worktree: "/wt/a" };
  const kept = await run(attempts([entry]).runs, base);
  assert.deepEqual(tasksOf(kept), [{ id: "a", kind: "task", branch: "pi/a", worktree: "/wt/a" }]);
  assert.match(kept.cleanup, /^recipe-gate abandon '\/t\/p' --keep 'implement\/p'/);

  const shared = await run(attempts([{ kind: "review", id: "a", branch: "pi/a-2", worktree: "/rw/other" }]).runs, base);
  assert.deepEqual(tasksOf(shared), []);
}

// A re-check that returned no worktree is not left behind; one that kept its worktree is.
{
  const gate = { ...mutationFixed.recheck["recheck-a"], recorded: false, branch: "pi/rc", worktree: "/cw/rc" };
  const withResult = (result) => fake({ ...mutationFixed, recheck: { "recheck-a": { result: { ok: true, structuredOutput: gate, ...result } } } });
  const gone = await run(withResult({ worktree: null, branch: null }).runs, base);
  assert.equal(gone.left.some((l) => l.worktree === "/cw/rc"), false);
  const kept = await run(withResult({ worktree: "/cw/rc" }).runs, base);
  assert.ok(kept.left.some((l) => l.worktree === "/cw/rc"));
  assert.match(kept.cleanup, /worktree remove --force '\/cw\/rc'/);
}

// A survivor that is neither caught by the fix nor claimed stays open.
{
  const f = fake({ ...mutationFixed, recheck: { "recheck-a": clean } });
  const receipt = await run(f.runs, base);
  assert.deepEqual(receipt.open, [
    "task a: mutation 1 still survives the check after the fix round",
    "task a: mutation 2 still survives the check after the fix round",
  ]);
  assert.deepEqual(receipt.mutations.a, { tried: 5, survived: 2, confirmed: 2, fixed: 0, equivalent: 0, claims: [] });
  assert.deepEqual(receipt.merged, ["a"]);
}

// A mutation step that fails is retried once and then recorded; the task still merges.
{
  const f = fake({ mutate: { "mutate-a": "engine error", "mutate-a-retry": "engine error" } });
  const receipt = await run(f.runs, base);
  const names = f.items().map((i) => i.key);
  assert.deepEqual(names.slice(names.indexOf("mutate-a"), names.indexOf("mutate-a") + 2), ["mutate-a", "mutate-a-retry"]);
  assert.equal(names.includes("impl-a-2"), false);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, ["task a: the mutation step did not run: engine error"]);
  assert.deepEqual(receipt.mutations, {});
}

// Survivors found when the fix rounds are used up are recorded and not fixed.
{
  const f = fake({
    review: { "review-a-1": needsWork, "review-a-2": needsWork },
    mutate: { "mutate-a": survivors },
  });
  const receipt = await run(f.runs, base);
  const names = f.items().map((i) => i.key);
  assert.equal(names.includes("impl-a-4"), false);
  assert.equal(names.includes("recheck-a"), false);
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, ["task a: 2 mutation(s) survive the check and the fix rounds are used up"]);
  assert.equal(receipt.mutations.a.confirmed, 2);
  assert.equal(receipt.mutations.a.fixed, 0);
}

// The review after a mutation fix gets its own fix round without a second mutation step.
{
  const f = fake({ ...mutationFixed, review: { "review-a-2": needsWork } });
  const receipt = await run(f.runs, base);
  const names = f.items().map((i) => i.key);
  assert.deepEqual(names.slice(names.indexOf("recheck-a")), ["recheck-a", "review-a-2", "impl-a-3", "review-a-3", "merge", "integrate"]);
  assert.equal(names.filter((x) => x === "mutate-a").length, 1);
  assert.deepEqual(receipt.merged, ["a"]);
}

// A re-check that did not run is recorded and the run goes on to the review.
{
  const f = fake({ mutate: { "mutate-a": survivors }, recheck: { "recheck-a": "gate timed out" } });
  const receipt = await run(f.runs, base);
  const names = f.items().map((i) => i.key);
  assert.ok(names.includes("review-a-2"));
  assert.deepEqual(receipt.merged, ["a"]);
  assert.deepEqual(receipt.open, ["task a: the mutation re-check did not run: gate timed out"]);
}

// The re-check claims every fix report of the round, in order, when the fix was relayed.
{
  const f = fake({ ...mutationFixed, impl: { "impl-a-2": handedOff("a", { line: "half the fix", key: "a-2" }) } });
  await run(f.runs, base);
  assert.equal(byKey(f)["recheck-a"].gate.command, "recipe-gate findings '/t/p/mutations-a.md' --check 'nixfmt --check a.nix' --claims '/t/p/impl-a-2.md' --claims '/t/p/impl-a-3.md' --run '/t/p' --id 'a'");
}

// A replan during a mutation fix round sends the new implementation to a review, not to the re-check.
{
  const f = fake({
    mutate: { "mutate-a": survivors },
    impl: { "impl-a-2": { ...taskGate("a"), ok: false, reason: "report blocked: needs more", report: { status: "blocked", why: "needs more" } } },
    diagnose: { "diagnose-a-1": diagnosis("replan", "the fix needs a different approach") },
  });
  await run(f.runs, base);
  const names = f.items().map((i) => i.key);
  assert.ok(names.indexOf("review-a-2") < names.indexOf("recheck-a") || names.indexOf("recheck-a") < 0);
  assert.deepEqual(names.slice(names.indexOf("diagnose-a-1")).slice(0, 3), ["diagnose-a-1", "impl-a-3", "review-a-2"]);
}

// Reviews and gates that could not run something say so in the open lines.
{
  const f = fake({ review: { "review-a-1": { ...clean, handoff: "handoff: read all, budget hit" } } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: review 1 hit the reviewer's budget: handoff: read all, budget hit"));
}
{
  const f = fake({ review: { "review-a-1": { ...clean, unrunnable: [{ n: 2, reason: "timed out after 600000 ms" }] } } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: review 1 could not run 1 reproduction(s): 2: timed out after 600000 ms"));
}
{
  const f = fake({ mutate: { "mutate-a": { ...clean, unrunnable: [{ n: 3, reason: "timed out after 600000 ms" }] } } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: the mutation step could not run 1 reproduction(s): 3: timed out after 600000 ms"));
}
{
  const f = fake({ ...mutationFixed, recheck: { "recheck-a": { ...clean, unrunnable: [{ n: 1, reason: "timed out after 600000 ms" }] } } });
  const receipt = await run(f.runs, base);
  assert.ok(receipt.open.includes("task a: the mutation re-check could not run 1 reproduction(s): 1: timed out after 600000 ms"));
}

// A stop while an implementer runs ends the graph without a set-aside task or a receipt.
{
  const f = fake({ impl: { "impl-a": { result: { ok: false, status: "aborted", error: "run stopped" } } } });
  await assert.rejects(run(f.runs, base), { name: "RunStopped" });
  assert.deepEqual(keys(f), [["intake"], ["pin"], ["impl-a"]]);
}

console.log("implement graph: ok");
