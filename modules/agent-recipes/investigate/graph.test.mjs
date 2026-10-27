/**
 * Dry run of the investigate graph with the shared library against a fake
 * `runs`. Run by `nix flake check`. It proves the script's own logic (pin,
 * reproduction, hypotheses, change and fix rounds, stuck detection, research,
 * the round cap, the receipt); the gates are not exercised, and the gate
 * results are the fake's. One scenario runs again through the runner's port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import graph from "./graph.mjs";
import { portOf, runThroughRunner } from "../runner/fake.mjs";

const run = (runs, args, emit = () => {}) => graph(Object.freeze(args), portOf(runs, emit));

const ok = (key, structuredOutput) => ({ ok: true, runId: `run-${key}`, structuredOutput });
const failed = (key, error) => ({ ok: false, runId: `run-${key}`, error });

const pinGate = { ok: true, reason: "", repo: "/r", base: "base0", base_ref: "refs/recipes/d/base", reused: false };
const reproGate = (key, extra = {}) => ({
  ok: true,
  reason: "",
  command: "c",
  expect: "fail",
  exit: 1,
  timed_out: false,
  tail: "boom",
  signature: "sigR",
  log: `/t/d/${key}.log`,
  branch: null,
  worktree: `/wt/${key}`,
  head: "base0",
  ...extra,
});
const hypotheses = {
  ok: true,
  hypotheses: [
    { rank: 1, claim: "the cache is stale", check: "read cache.js" },
    { rank: 2, claim: "the lock is not released", check: "read lock.js" },
    { rank: 3, claim: "a third one", check: "x" },
  ],
  problem: "",
};
const taskPass = (rank) => ({ ok: true, reason: "", report: { status: "done", why: "" }, branch: `pi/h${rank}`, worktree: `/wt/h${rank}`, signature: null });
const taskFail = (rank, signature, extra = {}) => ({ ok: false, reason: `verify failed (${signature})`, report: { status: "done", why: "" }, branch: `pi/h${rank}`, worktree: `/wt/h${rank}`, signature, ...extra });
const gateBase = { ok: true, reason: "", check: { command: "c", exit: 0, tail: "" }, reproduced: [], unreproduced: [], unrunnable: [], findings: 0, quotes_missing: [], branch: "pi/h1", worktree: "/rw/1" };
const clean = { ...gateBase, verdict: "clean" };
const needsWork = {
  ...gateBase,
  verdict: "needs-work",
  reproduced: [{ n: 1, kind: "sh", title: "B1. off by one", summary: "sh t.sh", exit: 1, tail: "FAIL" }],
  unreproduced: [{ n: 2, kind: "diff", title: "B2. unchecked", summary: "a.nix", exit: 1, tail: "" }],
  findings: 2,
};
const diagnosis = (action, reason, extra = {}) => ({ ok: true, action, reason, verdict: null, owns: [], brief: false, question: "", ...extra });
const urlList = (list) => ({ ok: list.length > 0, urls: list });
const src = (angle, n, kind) => ({ url: `https://example.com/${angle}/${n}`, angle, why: "w", kind });
const extractOk = { ok: true, bytes: 5000, quotes: 3, over_cap: false };

// `table` maps a child key to a result or a function of the item; a string is
// a failure message; an unlisted key gets the default for its kind.
function fake(table = {}) {
  const batches = [];
  const defaults = (item) => {
    const k = item.key;
    let m;
    if (k === "pin") return pinGate;
    if (k === "reproduce" || k === "verify-base") return reproGate(k);
    if (k === "hypothesize") return { ...hypotheses, branch: "pi/hyp", worktree: "/wt/hypothesize" };
    if ((m = /^change-(\d+)/.exec(k))) return taskPass(m[1]);
    if ((m = /^verify-(\d+)/.exec(k))) return taskPass(m[1]);
    if (k.startsWith("review-")) return clean;
    if (k.startsWith("diagnose-")) return diagnosis("decide", "a person has to choose");
    if (k.startsWith("extract-")) return extractOk;
    if (k.startsWith("locate-")) return { ok: true, paths: [] };
    return urlList([]);
  };
  return {
    batches,
    items: () => batches.flat(),
    runs: {
      all: async (items) => {
        batches.push(items);
        return items.map((item) => {
          let given = item.key in table ? table[item.key] : defaults(item);
          if (typeof given === "function") given = given(item);
          if (given && typeof given === "object" && "structuredOutput" in given) return { ok: true, runId: `run-${item.key}`, ...given };
          return typeof given === "string" ? failed(item.key, given) : ok(item.key, given);
        });
      },
    },
  };
}

const failedChild = "the child crashed";
const keys = (f) => f.items().map((i) => i.key);
const byKey = (f) => Object.fromEntries(f.items().map((i) => [i.key, i]));
const args = { dir: "/t/d", goal: "find the bug", repo: "/r", reproduce: "make repro" };
const outcomes = (r) => r.hypotheses.map((h) => h.outcome);

function assertSound(f) {
  const outputs = f.items().map((i) => i.output).filter(Boolean);
  assert.equal(new Set(outputs).size, outputs.length, "two children share an output path");
}

// Happy path.
{
  const f = fake();
  const r = await run(f.runs, args);
  assert.deepEqual(await runThroughRunner(graph, fake().runs, args), JSON.parse(JSON.stringify(r)));
  assert.deepEqual(keys(f), ["pin", "reproduce", "hypothesize", "change-1", "review-1-1"]);
  const k = byKey(f);
  assert.equal(k.pin.gate.command, "recipe-gate pin '/t/d' --repo '/r'");
  assert.equal(k.pin.agent, null);
  assert.equal(k.reproduce.agent, null);
  assert.equal(k.reproduce.worktree, true);
  assert.equal(k.reproduce.baseRef, "refs/recipes/d/base");
  assert.equal(k.reproduce.gate.command, "recipe-gate repro '/t/d' --command 'make repro' --expect fail --id 'reproduce'");
  assert.equal(k.reproduce.gate.timeoutMs, 660000);
  assert.equal(k.reproduce.task, undefined);
  assert.equal(k.reproduce.output, undefined);
  assert.equal(k.hypothesize.agent, "reviewer");
  assert.equal(k.hypothesize.worktree, true);
  assert.equal(k.hypothesize.baseRef, "refs/recipes/d/base");
  assert.equal(k.hypothesize.gate.command, "recipe-gate hypotheses '/t/d/hypotheses.md' --run '/t/d' --id 'hypothesize'");
  assert.match(k.hypothesize.task, /\/t\/d\/reproduce\.log/);
  assert.equal(k["change-1"].agent, "implementer");
  assert.equal(k["change-1"].worktree, true);
  assert.equal(k["change-1"].baseRef, "refs/recipes/d/base");
  assert.equal(k["change-1"].gate.command, "recipe-gate task '/t/d/change-1.md' --verify 'make repro' --repo '/r' --base 'base0' --run '/t/d' --id 'h1'");
  assert.equal(k["change-1"].gate.timeoutMs, 1260000);
  assert.match(k["change-1"].task, /Verify command: make repro/);
  assert.match(k["review-1-1"].task, /^Review a diff on a branch \(the diff variant\)/);
  assert.doesNotMatch(k["review-1-1"].task, /Implementer report/);
  assert.equal(k["review-1-1"].baseRef, "refs/heads/pi/h1");
  assert.equal(k["review-1-1"].gate.command, "recipe-gate findings '/t/d/review-1-1.md' --check 'make repro' --run '/t/d' --id 'h1'");
  assert.equal(k["review-1-1"].gate.timeoutMs, 6600000);
  assert.equal(r.branch, "pi/h1");
  assert.equal(r.review, "/t/d/review-1-1.md");
  assert.deepEqual(outcomes(r), ["fixed", "untried"]);
  assert.deepEqual(r.hypotheses.map((h) => h.rank), [1, 2]);
  assert.equal(r.base, "base0");
  assert.deepEqual(r.reproduction, { command: "make repro", exit: 1, signature: "sigR", log: "/t/d/reproduce.log" });
  assert.equal(r.verify, "make repro");
  assert.equal(r.check, null);
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.decide, []);
  assert.equal(r.cleanup, "recipe-gate abandon '/t/d' --keep 'pi/h1'");
  assert.ok(r.left.some((l) => l.worktree === "/wt/reproduce"));
  assert.ok(r.left.some((l) => l.branch === "pi/h1"));
  assert.ok(r.left.some((l) => l.worktree === "/wt/hypothesize" && l.kind === "hypothesize"));
  assertSound(f);
}

// A gate that answers without a result ends the step with an open line.
{
  for (const [key, line] of [
    ["change-1", "hypothesis 1: the task gate did not run"],
    ["review-1-1", "hypothesis 1: the review's verdict gate did not run"],
  ]) {
    const f = fake({ [key]: { structuredOutput: undefined } });
    const r = await run(f.runs, args);
    assert.equal(r.hypotheses[0].outcome, "gate did not run");
    assert.ok(r.open.includes(line), line);
    assert.ok(!keys(f).some((x) => x.startsWith("diagnose-")));
  }
  const f = fake({ hypothesize: { structuredOutput: undefined } });
  const r = await run(f.runs, args);
  assert.ok(r.open.includes("the hypotheses gate did not run"));
  assert.ok(!keys(f).some((x) => x.startsWith("diagnose-")));
}

// Verify, check and bad arguments.
{
  const f = fake();
  await run(f.runs, { ...args, verify: "make test", check: "make lint" });
  const k = byKey(f);
  assert.equal(
    k["change-1"].gate.command,
    "recipe-gate task '/t/d/change-1.md' --verify 'make test' --check 'make lint' --repo '/r' --base 'base0' --run '/t/d' --id 'h1'",
  );
  const g = fake();
  const r = await run(g.runs, { ...args, source: "ftp" });
  assert.ok(g.batches.length > 0);
  assert.ok(!r.open.some((l) => /source/.test(l)));
  const h = fake();
  const r2 = await run(h.runs, { dir: "/t/d", goal: "g" });
  assert.equal(h.batches.length, 0);
  assert.match(r2.open.join("\n"), /repo argument is required/);
  assert.match(r2.open.join("\n"), /reproduce argument is required/);
}

// The reproduction passes at the base: the run ends with an open line.
{
  const f = fake({ reproduce: reproGate("reproduce", { ok: false, reason: "the command passed at the base" }) });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f), ["pin", "reproduce"]);
  assert.equal(r.open.length, 1);
  assert.match(r.open[0], /did not fail at the base/);
  assert.equal(r.reproduction, null);
  assert.equal(r.branch, null);
}

// A separate verify must fail at the base too.
{
  const f = fake();
  await run(f.runs, { ...args, verify: "make test" });
  assert.deepEqual(keys(f).slice(0, 4), ["pin", "reproduce", "verify-base", "hypothesize"]);
  const vb = byKey(f)["verify-base"];
  assert.equal(vb.gate.command, "recipe-gate repro '/t/d' --command 'make test' --expect fail --id 'verify-base'");
  assert.equal(vb.gate.timeoutMs, 660000);
  assert.equal(vb.worktree, true);
  assert.equal(vb.baseRef, "refs/recipes/d/base");
  assert.ok(!keys(fake()).includes("verify-base"));
  const same = fake();
  await run(same.runs, { ...args, verify: "make repro" });
  assert.ok(!keys(same).includes("verify-base"));

  const g = fake({ "verify-base": reproGate("verify-base", { ok: false, reason: "passed at the base" }) });
  const r = await run(g.runs, { ...args, verify: "make test" });
  assert.deepEqual(keys(g), ["pin", "reproduce", "verify-base"]);
  assert.equal(r.open.length, 1);
  assert.match(r.open[0], /does not fail at the base/);
}

// Stuck detection.
{
  const f = fake({
    "change-1": taskFail(1, "sigA"),
    "change-1-2": taskFail(1, "sigA"),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f), ["pin", "reproduce", "hypothesize", "change-1", "change-1-2", "diagnose-h1-1"]);
  const k = byKey(f);
  assert.equal(k["change-1-2"].agent, "implementer");
  assert.equal(k["change-1-2"].worktree, true);
  assert.equal(k["change-1-2"].baseRef, "refs/heads/pi/h1");
  assert.equal(k["change-1-2"].gate.timeoutMs, 1260000);
  assert.equal(
    k["change-1-2"].gate.command,
    "recipe-gate task '/t/d/change-1-2.md' --verify 'make repro' --repo '/r' --base 'base0' --run '/t/d' --id 'h1'",
  );
  assert.match(k["change-1-2"].task, /you are in your own worktree of the branch pi\/h1/);
  assert.match(k["change-1-2"].task, /The task gate reported: verify failed \(sigA\)/);
  assert.match(k["diagnose-h1-1"].task, /Allowed actions: fix, next, research, decide/);
  assert.equal(r.decide.length, 1);
  assert.deepEqual(outcomes(r), ["needs a decision", "untried"]);
  assert.equal(r.rounds_used, 2);
  assertSound(f);

  // The reproduction's own signature is stuck at once, with no fix round.
  const g = fake({ "change-1": taskFail(1, "sigR") });
  await run(g.runs, args);
  assert.deepEqual(keys(g), ["pin", "reproduce", "hypothesize", "change-1", "diagnose-h1-1"]);

  // A separate verify seeds the signatures with its own failure at the base, not the reproduction's.
  const base = { "verify-base": reproGate("verify-base", { signature: "sigB" }) };
  const h = fake({ ...base, "change-1": taskFail(1, "sigR") });
  await run(h.runs, { ...args, verify: "make test" });
  assert.deepEqual(keys(h).slice(4, 7), ["change-1", "change-1-2", "review-1-1"]);
  const h2 = fake({ ...base, "change-1": taskFail(1, "sigB") });
  await run(h2.runs, { ...args, verify: "make test" });
  assert.deepEqual(keys(h2).slice(4, 6), ["change-1", "diagnose-h1-1"]);
}

// A retried fix round carries the findings again.
{
  const f = fake({
    "change-1": taskFail(1, "sigA"),
    "change-1-2": failedChild,
    "change-1-2-retry": failedChild,
    "diagnose-h1-1": diagnosis("retry", "try once more"),
  });
  await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "change-1-2-retry", "diagnose-h1-1", "change-1-3", "review-1-1"]);
  const k = byKey(f);
  assert.equal(k["change-1-3"].baseRef, "refs/heads/pi/h1");
  assert.match(k["change-1-3"].task, /The task gate reported: verify failed \(sigA\)/);
}

// Research: a diagnosis asks a question, sources are read, the fix round carries the notes.
{
  const table = {
    "change-1": taskFail(1, "sigR"),
    "diagnose-h1-1": diagnosis("research", "the cause is not in the code", { question: "How does the cache expire?" }),
    "search-h1-r1": urlList([1, 2, 3, 4, 5].map((n) => src("h1-r1", n, n === 1 ? "primary" : "secondary"))),
  };
  const f = fake(table);
  const r = await run(f.runs, args);
  const ks = keys(f);
  assert.deepEqual(ks.slice(3, 7), ["change-1", "diagnose-h1-1", "search-h1-r1", "locate-h1-r1"]);
  assert.deepEqual(ks.slice(7, 10), ["extract-h1-r1-1", "extract-h1-r1-2", "extract-h1-r1-3"]);
  assert.deepEqual(ks.slice(10), ["change-1-2", "review-1-1"]);
  const k = byKey(f);
  assert.match(k["diagnose-h1-1"].task, /Allowed actions: fix, next, research, decide/);
  assert.equal(k["change-1-2"].baseRef, "refs/heads/pi/h1");
  assert.ok("gate" in k["change-1-2"]);
  const files = [1, 2, 3].map((n) => `/t/d/research/h1-r1/extract-${n}.md`);
  assert.ok(
    k["change-1-2"].task.includes(`Research notes for the question "How does the cache expire?" are in: ${files.join(", ")}. Read them before the next edit.`),
  );
  assert.deepEqual(r.researched, [{ hypothesis: 1, question: "How does the cache expire?", extracts: files, open: [] }]);
  assert.equal(r.branch, "pi/h1");
  assertSound(f);

}

// Research is allowed twice per run; after that a diagnosis no longer offers it.
{
  const f = fake({
    "change-1": taskFail(1, "sigR"),
    "change-1-2": taskFail(1, "sigR"),
    "change-1-3": taskFail(1, "sigR"),
    "change-2": taskFail(2, "sigR"),
    "diagnose-h1-1": diagnosis("research", "a", { question: "Q1?" }),
    "diagnose-h1-2": diagnosis("research", "b", { question: "Q2?" }),
    "search-h1-r1": urlList([src("h1-r1", 1, "primary")]),
    "search-h1-r2": urlList([src("h1-r2", 1, "primary")]),
  });
  const r = await run(f.runs, args);
  assert.equal(r.researched.length, 2);
  const k = byKey(f);
  assert.match(k["diagnose-h1-1"].task, /Allowed actions: fix, next, research, decide/);
  assert.match(k["diagnose-h1-2"].task, /Allowed actions: fix, next, research, decide/);
  assert.match(k["diagnose-h2-1"].task, /Allowed actions: fix, decide/);
}

// next and a refuted hypothesis each start the second one fresh from the base.
{
  const f = fake({ "change-1": taskFail(1, "sigR"), "diagnose-h1-1": diagnosis("next", "wrong place") });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "diagnose-h1-1", "change-2", "review-2-1"]);
  const k = byKey(f);
  assert.equal(k["change-2"].baseRef, "refs/recipes/d/base");
  assert.match(k["change-2"].task, /Hypothesis 2: the lock is not released/);
  assert.match(r.hypotheses[0].outcome, /^dropped: wrong place/);
  assert.equal(r.hypotheses[1].outcome, "fixed");
  assert.equal(r.branch, "pi/h2");

  const g = fake({
    "change-1": { ok: false, reason: "refuted", report: { status: "blocked", why: "hypothesis refuted: the cache is fine" }, branch: "pi/h1", worktree: "/wt/h1", signature: "s" },
  });
  const r2 = await run(g.runs, args);
  assert.deepEqual(keys(g).slice(3), ["change-1", "change-2", "review-2-1"]);
  assert.equal(byKey(g)["change-2"].baseRef, "refs/recipes/d/base");
  assert.match(r2.hypotheses[0].outcome, /^refuted: the cache is fine/);
  assert.equal(r2.decide.length, 0);
}

// Every hypothesis dropped: the run asks for a decision.
{
  const f = fake({
    "change-1": taskFail(1, "sigR"),
    "change-2": taskFail(2, "sigR"),
    "diagnose-h1-1": diagnosis("next", "no"),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "diagnose-h1-1", "change-2", "diagnose-h2-1"]);
  assert.match(byKey(f)["diagnose-h2-1"].task, /Allowed actions: fix, research, decide/);
  assert.equal(r.branch, null);
  assert.equal(r.decide.length, 1);
}

// Out of recoveries moves on without a decision; the last one asks.
{
  const fixing = (n) => diagnosis("fix", `try again ${n}`);
  const f = fake({
    "change-1": taskFail(1, "sigR"),
    "change-1-2": taskFail(1, "sigR"),
    "change-1-3": taskFail(1, "sigR"),
    "diagnose-h1-1": fixing(1),
    "diagnose-h1-2": fixing(2),
    "change-2": taskFail(2, "sigR"),
    "change-2-2": taskFail(2, "sigR"),
    "change-2-3": taskFail(2, "sigR"),
    "diagnose-h2-1": fixing(3),
    "diagnose-h2-2": fixing(4),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), [
    "change-1", "diagnose-h1-1", "change-1-2", "diagnose-h1-2", "change-1-3",
    "change-2", "diagnose-h2-1", "change-2-2", "diagnose-h2-2", "change-2-3",
  ]);
  assert.equal(r.hypotheses[0].outcome, "dropped: out of recoveries");
  assert.equal(r.hypotheses[1].outcome, "needs a decision");
  assert.equal(r.decide.length, 1);
  assert.equal(r.decide[0].id, "h2");
  assertSound(f);
}

// A clean review that hit the reviewer's budget or could not run reproductions says so in open.
{
  const f = fake({
    "review-1-1": { ...clean, handoff: "ran out of room", unrunnable: [{ n: 2, reason: "needs a gpu", title: "t", summary: "s" }] },
  });
  const r = await run(f.runs, args);
  assert.ok(r.open.includes("hypothesis 1: review 1 hit the reviewer's budget: ran out of room"));
  assert.ok(r.open.includes("hypothesis 1: review 1 could not run 1 reproduction(s): 2: needs a gpu"));
}

// The round cap counts every implementer run.
{
  const f = fake(Object.fromEntries(["change-1", "change-1-2", "change-1-3", "change-1-4", "change-1-5", "change-1-6", "change-1-7"].map((k, i) => [k, taskFail(1, "sig" + i)])));
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "change-1-3", "change-1-4", "change-1-5", "change-1-6"]);
  assert.equal(r.hypotheses[0].outcome, "out of rounds");
  assert.equal(r.rounds_used, 6);
  assert.match(r.open.join("\n"), /out of rounds/);
  assert.equal(r.branch, null);
}

// A review that needs work leads to a fresh implementer on the branch and a second review.
{
  let reviews = 0;
  const f = fake({ "review-1-1": needsWork, "review-1-2": () => (reviews++, clean) });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "review-1-1", "change-1-2", "review-1-2"]);
  const k = byKey(f);
  assert.equal(k["change-1-2"].baseRef, "refs/heads/pi/h1");
  assert.ok("gate" in k["change-1-2"]);
  assert.match(k["change-1-2"].task, /review-1-1\.md/);
  assert.match(k["change-1-2"].task, /showed these defects at the branch head/);
  assert.match(k["change-1-2"].task, /1\. \[B1\. off by one\] sh t\.sh -> exit 1\nFAIL/);
  assert.match(k["change-1-2"].task, /Advice from the review, not required: B2\. unchecked: a\.nix$/m);
  assert.doesNotMatch(k["review-1-2"].task, /Implementer report|Earlier review|re-review/);
  assert.equal(r.review, "/t/d/review-1-2.md");
  assert.equal(r.branch, "pi/h1");
  assert.equal(r.hypotheses[0].rounds, 2);
  assertSound(f);
}

// The review's check joins the verify command and the light check.
{
  const f = fake();
  await run(f.runs, { ...args, verify: "make test", check: "make lint" });
  assert.equal(byKey(f)["review-1-1"].gate.command, "recipe-gate findings '/t/d/review-1-1.md' --check 'make test && make lint' --run '/t/d' --id 'h1'");
}

// A review that gave no verdict is diagnosed with retry or decide only.
{
  const f = fake({ "review-1-1": { ...gateBase, ok: false, verdict: null, reason: "handoff" } });
  await run(f.runs, args);
  const d = byKey(f)["diagnose-h1-1"];
  assert.ok(d);
  assert.match(d.gate.command, /--allow 'retry,decide'/);
  assert.match(d.task, /the review gave no verdict: handoff/);
}

// A failing check at head is the first item of the fix brief.
{
  const f = fake({ "review-1-1": { ...needsWork, check: { command: "c", exit: 1, tail: "boom" }, reproduced: [], unreproduced: [] } });
  await run(f.runs, args);
  assert.match(byKey(f)["change-1-2"].task, /1\. The task's check failed at head -> exit 1\nboom/);
}

// No hypotheses ends the run when the diagnosis cannot help.
{
  const f = fake({ hypothesize: { ok: false, hypotheses: [], problem: "only one hypothesis" } });
  const r = await run(f.runs, args);
  assert.ok(!keys(f).some((k) => k.startsWith("change-")));
  assert.equal(r.branch, null);
  assert.ok(r.open.length + r.decide.length > 0);
}

// A child that hands off: the gate reports status handoff and the result carries the note.
const taskHandoff = (branch, head, commits = 1, why = "wiring left") => ({
  ok: false,
  reason: `report handoff: ${why}`,
  report: { status: "handoff", why },
  branch,
  worktree: `/wt/${branch.replace("pi/", "")}`,
  head,
  commits,
  signature: null,
});
const handedOff = (key, gate, line, { note = `/t/d/${key}.md`, budget = { tokens: 80000, reserve: 8000, action: "commit" }, firstContext = 1000 } = {}) => ({
  structuredOutput: gate,
  handoff: { line: `handoff: ${line}`, unread: [], note, empty: false },
  ...(budget ? { budget } : {}),
  usage: { firstContext },
});
const planGate = (tasks, extra = {}) => ({ ok: true, tasks, oversize: [], overlaps: [], missing: [], cycles: [], ...extra });
const piece = (id, owns, check, est = 30000) => ({ id, file: `/t/d/split/h1-1/tasks/${id}.md`, owns, reads: [], check, depends: [], research: "", est });
const pieces = planGate([piece("h1-a", ["a.js"], "check a"), piece("h1-b", ["b.js"], "check b")]);
const pieceDone = (branch, head) => ({ ok: true, reason: "", report: { status: "done", why: "" }, branch, worktree: `/wt/${branch.replace("pi/", "")}`, head, commits: 1, signature: null });
const reviewClean = (branch) => ({ ...clean, branch });

// A change that hands off is relayed from its branch with the note; a second handoff with the
// same head is split, and the pieces run in order from each other's branch before one verify and one review.
{
  const table = {
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left"),
    "split-1-1": pieces,
    "piece-h1-a": pieceDone("pi/pa", "HA"),
    "piece-h1-b": pieceDone("pi/pb", "HB"),
    "verify-1s1": { ...taskPass(1), branch: "pi/pb", worktree: "/wt/pb" },
    "review-1-1": reviewClean("pi/pb"),
  };
  const f = fake(table);
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "split-1-1", "piece-h1-a", "piece-h1-b", "verify-1s1", "review-1-1"]);
  const k = byKey(f);
  assert.equal(k["change-1-2"].agent, "implementer");
  assert.equal(k["change-1-2"].baseRef, "refs/heads/pi/h1");
  assert.equal(k["change-1-2"].handoffOf, "run-change-1");
  assert.equal(k["change-1-2"].handoffAs, "relay");
  assert.ok(k["change-1-2"].task.includes("Continue this task from the handoff note at /t/d/change-1.md; the branch pi/h1 holds the committed work"));
  assert.equal(k["change-1-2"].gate.command, k["change-1"].gate.command.replace("change-1.md", "change-1-2.md"));
  assert.equal(k["change-1"].baseRef, "refs/recipes/d/base");

  assert.equal(k["split-1-1"].agent, "planner");
  assert.equal(k["split-1-1"].big, true);
  assert.equal(k["split-1-1"].handoffOf, "run-change-1-2");
  assert.equal(k["split-1-1"].handoffAs, "split");
  assert.equal(k["split-1-1"].gate.command, "recipe-gate plan '/t/d/split/h1-1' --repo '/wt/h1b' --limit 40000");
  assert.match(k["split-1-1"].task, /Handoff note: \/t\/d\/change-1-2\.md/);
  assert.match(k["split-1-1"].task, /Hypothesis 1: the cache is stale/);
  assert.match(k["split-1-1"].task, /git diff base0\.\.pi\/h1b/);

  assert.equal(k["piece-h1-a"].agent, "implementer");
  assert.equal(k["piece-h1-a"].baseRef, "refs/heads/pi/h1b");
  assert.equal(k["piece-h1-a"].gate.command, "recipe-gate task '/t/d/piece-h1-a.md' --check 'check a' --owns 'a.js' --repo '/r' --base 'H1' --run '/t/d' --id 'h1-h1-a'");
  assert.match(k["piece-h1-a"].task, /task file: \/t\/d\/split\/h1-1\/tasks\/h1-a\.md/);
  assert.equal(k["piece-h1-b"].baseRef, "refs/heads/pi/pa");
  assert.equal(k["piece-h1-b"].gate.command, "recipe-gate task '/t/d/piece-h1-b.md' --check 'check b' --owns 'b.js' --repo '/r' --base 'HA' --run '/t/d' --id 'h1-h1-b'");
  assert.equal(
    k["verify-1s1"].gate.command,
    "recipe-gate task '/t/d/piece-h1-b.md' --verify 'make repro' --repo '/r' --base 'base0' --run '/t/d' --id 'h1' --in '/wt/pb'",
  );
  assert.ok(!k["verify-1s1"].worktree);
  assert.equal(k["verify-1s1"].agent, null);
  assert.equal(k["review-1-1"].baseRef, "refs/heads/pi/pb");
  assert.match(k["review-1-1"].task, /Diff to review: git diff base0\.\.pi\/pb/);
  assert.equal(f.items().filter((i) => i.key.startsWith("review-")).length, 1);

  assert.equal(r.branch, "pi/pb");
  assert.equal(r.rounds_used, 4);
  assert.equal(r.hypotheses[0].outcome, "fixed");
  assert.equal(r.hypotheses[0].relays, 1);
  assert.equal(r.hypotheses[0].splits, 1);
  assert.equal(r.hypotheses[0].rounds, 4);
  assert.ok(r.left.some((l) => l.kind === "relay" && l.branch === "pi/h1"));
  assert.ok(r.left.some((l) => l.kind === "relay" && l.branch === "pi/h1b"));
  assert.deepEqual(r.decide, []);
  assert.equal(r.cleanup, "recipe-gate abandon '/t/d' --keep 'pi/pb'");
  assertSound(f);

}

// A handoff with no usable budget still splits, at half the plan gate's default limit.
{
  const f = fake({
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left", { budget: null }),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left", { budget: null }),
    "split-1-1": planGate([piece("h1-a", ["a.js"], "check a", 90000), piece("h1-b", ["b.js"], "check b", 90000)]),
  });
  const r = await run(f.runs, args);
  assert.equal(byKey(f)["split-1-1"].gate.command, "recipe-gate plan '/t/d/split/h1-1' --repo '/wt/h1b' --limit 50000");
  assert.ok(keys(f).includes("piece-h1-a"));
  assert.equal(r.hypotheses[0].splits, 1);
}

// A split plan that does not hold up goes to a decision.
{
  const f = fake({
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left"),
    "split-1-1": planGate([piece("h1-a", ["a.js"], "check a")]),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "split-1-1"]);
  assert.equal(r.decide.length, 1);
  assert.equal(r.decide[0].step, "split");
  assert.equal(r.hypotheses[0].outcome, "needs a decision");
  assert.equal(r.hypotheses[0].splits, 0);

  const g = fake({
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left"),
    "split-1-1": planGate([piece("h1-a", ["a.js"], "check a", 80000), piece("h1-b", ["b.js"], "check b")]),
  });
  const r2 = await run(g.runs, args);
  assert.equal(r2.decide.length, 1);
  assert.equal(r2.decide[0].step, "split");
}

// A piece that hands off with nothing committed, or the same remainder twice, goes to a decision.
{
  const base = {
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left"),
    "split-1-1": pieces,
  };
  const f = fake({ ...base, "piece-h1-a": handedOff("piece-h1-a", taskHandoff("pi/pa", "H1", 0), "parser left") });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "split-1-1", "piece-h1-a"]);
  assert.equal(r.decide.length, 1);
  assert.equal(r.decide[0].step, "piece");
  assert.match(r.decide[0].question, /nothing committed after a split/);
  assert.equal(r.hypotheses[0].outcome, "needs a decision");

  const g = fake({
    ...base,
    "piece-h1-a": handedOff("piece-h1-a", taskHandoff("pi/pa", "HA"), "parser left"),
    "piece-h1-a-2": handedOff("piece-h1-a-2", taskHandoff("pi/pa2", "HA2"), "Parser left!"),
  });
  const r2 = await run(g.runs, args);
  assert.deepEqual(keys(g).slice(6), ["piece-h1-a", "piece-h1-a-2"]);
  const relayed = byKey(g)["piece-h1-a-2"];
  assert.equal(relayed.baseRef, "refs/heads/pi/pa");
  assert.match(relayed.task, /Continue this task from the handoff note at \/t\/d\/piece-h1-a\.md; the branch pi\/pa/);
  assert.equal(relayed.gate.command, byKey(g)["piece-h1-a"].gate.command.replace("piece-h1-a.md", "piece-h1-a-2.md"));
  assert.equal(r2.decide.length, 1);
  assert.match(r2.decide[0].question, /same remainder/);

  // The same remainder at the top level.
  const h = fake({
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H2"), "wiring left"),
  });
  const r3 = await run(h.runs, args);
  assert.deepEqual(keys(h).slice(3), ["change-1", "change-1-2"]);
  assert.match(r3.decide[0].question, /same remainder/);
}

// The split planner reads the hypotheses file the hypothesize step settled on, which is the merged file after a handoff.
{
  const gate = { ...hypotheses, branch: "pi/hyp", worktree: "/wt/hypothesize" };
  const f = fake({
    hypothesize: { structuredOutput: gate, handoff: { line: "handoff: cache.js left", unread: ["cache.js"], note: "/t/d/hypotheses.md", empty: false } },
    "hypothesize-part-1": gate,
    "hypothesize-merge": gate,
    "change-1": handedOff("change-1", taskHandoff("pi/h1", "H1"), "wiring left"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1b", "H1"), "tests left"),
    "split-1-1": pieces,
  });
  await run(f.runs, args);
  assert.match(byKey(f)["split-1-1"].task, /Task file: \/t\/d\/hypotheses\.merged\.md$/m);
}

// Handoffs that ended before their note, on different heads, relay again rather than count as the same remainder.
{
  const ended = (key, branch, head) => ({
    ...handedOff(key, taskHandoff(branch, head), "ended by the context valve before its note", { note: null }),
    handoff: { line: "handoff: ended by the context valve before its note", unread: [], note: null, empty: true },
  });
  const f = fake({ "change-1": ended("change-1", "pi/h1", "H1"), "change-1-2": ended("change-1-2", "pi/h1b", "H2") });
  const r = await run(f.runs, args);
  assert.ok(keys(f).includes("change-1-3"));
  assert.equal(r.decide.length, 0);
}

// A fix round that hands off is relayed like any other change.
{
  const f = fake({
    "change-1": taskFail(1, "sigA"),
    "change-1-2": handedOff("change-1-2", taskHandoff("pi/h1", "H9", 2, "findings half fixed"), "findings half fixed"),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "change-1-3", "review-1-1"]);
  const k = byKey(f);
  assert.equal(k["change-1-3"].baseRef, "refs/heads/pi/h1");
  assert.equal(k["change-1-3"].handoffOf, "run-change-1-2");
  assert.equal(k["change-1-3"].handoffAs, "relay");
  assert.match(k["change-1-3"].task, /Continue this task from the handoff note at \/t\/d\/change-1-2\.md; the branch pi\/h1 holds/);
  assert.equal(r.rounds_used, 3);
  assert.equal(r.hypotheses[0].relays, 1);
  assert.equal(r.branch, "pi/h1");
  assertSound(f);
}

// Through the runner, the reply of a child that handed off becomes the note its successor is told to read.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "investigate-handoff-"));
  const f = fake({ "change-1": { structuredOutput: taskHandoff("pi/h1", "H1"), finalText: "handoff: wiring left" } });
  const r = await runThroughRunner(graph, f.runs, { ...args, dir: d });
  assert.deepEqual(keys(f).slice(3), ["change-1", "change-1-2", "review-1-1"]);
  const relayed = byKey(f)["change-1-2"];
  assert.equal(relayed.baseRef, "refs/heads/pi/h1");
  assert.ok(relayed.task.includes(`Continue this task from the handoff note at ${d}/change-1.md; the branch pi/h1 holds the committed work`));
  assert.equal(fs.readFileSync(`${d}/change-1.md`, "utf8"), "handoff: wiring left");
  assert.equal(r.hypotheses[0].relays, 1);
  assert.equal(r.branch, "pi/h1");
}

// A stop while the reproduction runs ends the graph.
{
  const f = fake({ reproduce: { structuredOutput: undefined, ok: false, status: "aborted", error: "run stopped" } });
  await assert.rejects(run(f.runs, args), { name: "RunStopped" });
  assert.equal(keys(f).at(-1), "reproduce");
}
