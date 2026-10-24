/**
 * Dry run of the investigate graph with the shared library against a fake
 * `runs`. Run by `nix flake check`. It proves the script's own logic (pin,
 * reproduction, hypotheses, change and fix rounds, stuck detection, research,
 * the round cap, the receipt); the gates are not exercised, and the gate
 * results are the fake's. One scenario runs again in pi-subagents' own sandbox.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { hostRun } from "../lib/host-run.mjs";

const source =
  fs.readFileSync(new URL("../lib/recipe-lib.js", import.meta.url), "utf8") + "\n" + fs.readFileSync(new URL("./graph.js", import.meta.url), "utf8");
assert.ok(!/\basync\b/.test(source), "workflow scripts may not define async functions");
assert.ok(!/setTimeout/.test(source), "the sandbox has no setTimeout");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = (runs, args) => new AsyncFunction("runs", "args", "emit", source)(runs, Object.freeze(args), () => {});

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
const clean = { ok: true, verdict: "clean", branch: "pi/h1", worktree: "/rw/1" };
const needsWork = { ok: true, verdict: "needs-work", branch: "pi/h1", worktree: "/rw/1" };
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
    if ((m = /^verify-(\d+)-/.exec(k))) return taskPass(m[1]);
    if (k.startsWith("review-")) return clean;
    if (k.startsWith("fix-")) return undefined;
    if (k.startsWith("diagnose-")) return diagnosis("decide", "a person has to choose");
    if (k.startsWith("extract-")) return extractOk;
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
          return typeof given === "string" ? failed(item.key, given) : ok(item.key, given);
        });
      },
    },
  };
}

const keys = (f) => f.items().map((i) => i.key);
const byKey = (f) => Object.fromEntries(f.items().map((i) => [i.key, i]));
const args = { dir: "/t/d", goal: "find the bug", repo: "/r", reproduce: "make repro" };
const outcomes = (r) => r.hypotheses.map((h) => h.outcome);

function assertSound(f) {
  for (const i of f.items()) assert.ok(!(i.resume && i.gate), `${i.key} has both resume and gate`);
  const outputs = f.items().map((i) => i.output).filter(Boolean);
  assert.equal(new Set(outputs).size, outputs.length, "two children share an output path");
}

// Happy path.
{
  const f = fake();
  const r = await run(f.runs, args);
  assert.deepEqual(await hostRun(source, fake().runs, args), JSON.parse(JSON.stringify(r)));
  assert.deepEqual(keys(f), ["pin", "reproduce", "hypothesize", "change-1", "review-1-1"]);
  const k = byKey(f);
  assert.equal(k.pin.gate.command, "recipe-gate pin '/t/d' --repo '/r'");
  assert.equal(k.reproduce.agent, "scout");
  assert.equal(k.reproduce.worktree, true);
  assert.equal(k.reproduce.baseRef, "refs/recipes/d/base");
  assert.equal(k.reproduce.gate.command, "recipe-gate repro '/t/d' --command 'make repro' --expect fail --id 'reproduce'");
  assert.equal(k.reproduce.gate.timeoutMs, 660000);
  assert.equal(k.reproduce.task, "Write the single word done to /t/d/reproduce.md.");
  assert.doesNotMatch(k.reproduce.task, /run `recipe-gate/);
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
  assert.equal(k["review-1-1"].baseRef, "refs/heads/pi/h1");
  assert.equal(k["review-1-1"].gate.command, "recipe-gate verdict '/t/d/review-1-1.md' --run '/t/d' --id 'h1'");
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
  assert.equal(g.batches.length, 0);
  assert.equal(r.open.length, 1);
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
    "verify-1-1": taskFail(1, "sigA"),
  });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f), ["pin", "reproduce", "hypothesize", "change-1", "fix-1-1", "verify-1-1", "diagnose-h1-1"]);
  const k = byKey(f);
  assert.equal(k["fix-1-1"].resume, "run-change-1");
  assert.ok(!("gate" in k["fix-1-1"]));
  assert.equal(k["verify-1-1"].agent, "scout");
  assert.equal(k["verify-1-1"].worktree, false);
  assert.equal(k["verify-1-1"].gate.timeoutMs, 1260000);
  assert.equal(
    k["verify-1-1"].gate.command,
    "recipe-gate task '/t/d/fix-1-1.md' --verify 'make repro' --repo '/r' --base 'base0' --run '/t/d' --id 'h1' --in '/wt/h1'",
  );
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
  assert.deepEqual(keys(h).slice(4, 7), ["change-1", "fix-1-1", "verify-1-1"]);
  const h2 = fake({ ...base, "change-1": taskFail(1, "sigB") });
  await run(h2.runs, { ...args, verify: "make test" });
  assert.deepEqual(keys(h2).slice(4, 6), ["change-1", "diagnose-h1-1"]);
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
  assert.deepEqual(ks.slice(3, 6), ["change-1", "diagnose-h1-1", "search-h1-r1"]);
  assert.deepEqual(ks.slice(6, 9), ["extract-h1-r1-1", "extract-h1-r1-2", "extract-h1-r1-3"]);
  assert.deepEqual(ks.slice(9), ["fix-1-1", "verify-1-1", "review-1-1"]);
  const k = byKey(f);
  assert.match(k["diagnose-h1-1"].task, /Allowed actions: fix, next, research, decide/);
  assert.equal(k["fix-1-1"].resume, "run-change-1");
  assert.ok(!("gate" in k["fix-1-1"]));
  const files = [1, 2, 3].map((n) => `/t/d/research/h1-r1/extract-${n}.md`);
  assert.ok(
    k["fix-1-1"].task.includes(`Research notes for the question "How does the cache expire?" are in: ${files.join(", ")}. Read them before the next edit.`),
  );
  assert.deepEqual(r.researched, [{ hypothesis: 1, question: "How does the cache expire?", extracts: files, open: [] }]);
  assert.equal(r.branch, "pi/h1");
  assertSound(f);

  const g = fake({
    ...table,
    "locate-h1-r1": { ok: true, paths: [{ path: "src/cache.js", kind: "primary", why: "w", range: { start: 1, end: 9 } }] },
    "extract-h1-r1-1": extractOk,
  });
  const r2 = await run(g.runs, { ...args, source: "repo" });
  const gk = keys(g);
  assert.ok(gk.includes("locate-h1-r1"));
  assert.ok(!gk.includes("search-h1-r1"));
  assert.deepEqual(r2.researched[0].extracts, ["/t/d/research/h1-r1/extract-1.md"]);
  assert.ok(gk.indexOf("fix-1-1") > gk.indexOf("extract-h1-r1-1"));
}

// Research is allowed twice per run; after that a diagnosis no longer offers it.
{
  const f = fake({
    "change-1": taskFail(1, "sigR"),
    "verify-1-1": taskFail(1, "sigR"),
    "verify-1-2": taskFail(1, "sigR"),
    "change-2": taskFail(2, "sigR"),
    "diagnose-h1-1": diagnosis("research", "a", { question: "Q1?" }),
    "diagnose-h1-2": diagnosis("research", "b", { question: "Q2?" }),
    "search-h1-r1": urlList([src("h1-r1", 1, "primary")]),
    "search-h1-r2": urlList([src("h1-r2", 1, "primary")]),
  });
  const r = await run(f.runs, { ...args, rounds: 10 });
  assert.equal(r.researched.length, 2);
  const k = byKey(f);
  assert.match(k["diagnose-h1-1"].task, /Allowed actions: fix, next, research, decide/);
  assert.match(k["diagnose-h1-2"].task, /Allowed actions: fix, next, research, decide/);
  assert.match(k["diagnose-h2-1"].task, /Allowed actions: fix, decide/);
}

// next and a refuted hypothesis each start the second one without resume.
{
  const f = fake({ "change-1": taskFail(1, "sigR"), "diagnose-h1-1": diagnosis("next", "wrong place") });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "diagnose-h1-1", "change-2", "review-2-1"]);
  const k = byKey(f);
  assert.ok(!("resume" in k["change-2"]));
  assert.match(k["change-2"].task, /Hypothesis 2: the lock is not released/);
  assert.match(r.hypotheses[0].outcome, /^dropped: wrong place/);
  assert.equal(r.hypotheses[1].outcome, "fixed");
  assert.equal(r.branch, "pi/h2");

  const g = fake({
    "change-1": { ok: false, reason: "refuted", report: { status: "blocked", why: "hypothesis refuted: the cache is fine" }, branch: "pi/h1", worktree: "/wt/h1", signature: "s" },
  });
  const r2 = await run(g.runs, args);
  assert.deepEqual(keys(g).slice(3), ["change-1", "change-2", "review-2-1"]);
  assert.ok(!("resume" in byKey(g)["change-2"]));
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
    "verify-1-1": taskFail(1, "sigR"),
    "verify-1-2": taskFail(1, "sigR"),
    "diagnose-h1-1": fixing(1),
    "diagnose-h1-2": fixing(2),
    "change-2": taskFail(2, "sigR"),
    "verify-2-1": taskFail(2, "sigR"),
    "verify-2-2": taskFail(2, "sigR"),
    "diagnose-h2-1": fixing(3),
    "diagnose-h2-2": fixing(4),
  });
  const r = await run(f.runs, { ...args, rounds: 10 });
  assert.deepEqual(keys(f).slice(3), [
    "change-1", "diagnose-h1-1", "fix-1-1", "verify-1-1", "diagnose-h1-2", "fix-1-2", "verify-1-2",
    "change-2", "diagnose-h2-1", "fix-2-1", "verify-2-1", "diagnose-h2-2", "fix-2-2", "verify-2-2",
  ]);
  assert.equal(r.hypotheses[0].outcome, "dropped: out of recoveries");
  assert.equal(r.hypotheses[1].outcome, "needs a decision");
  assert.equal(r.decide.length, 1);
  assert.equal(r.decide[0].id, "h2");
  assertSound(f);
}

// The round cap counts change and fix runs.
{
  const f = fake({
    "change-1": taskFail(1, "sigA"),
    "verify-1-1": taskFail(1, "sigB"),
    "verify-1-2": taskFail(1, "sigC"),
  });
  const r = await run(f.runs, { ...args, rounds: 2 });
  assert.equal(f.items().filter((i) => i.agent === "implementer" || i.resume).length, 2);
  assert.deepEqual(keys(f).slice(3), ["change-1", "fix-1-1", "verify-1-1"]);
  assert.equal(r.hypotheses[0].outcome, "out of rounds");
  assert.equal(r.rounds_used, 2);
  assert.match(r.open.join("\n"), /out of rounds/);
  assert.equal(r.branch, null);
  assert.equal(r.cleanup, "recipe-gate abandon '/t/d'");
}

// A review that needs work leads to a resumed fix, a verify node and a second review.
{
  let reviews = 0;
  const f = fake({ "review-1-1": needsWork, "review-1-2": () => (reviews++, clean) });
  const r = await run(f.runs, args);
  assert.deepEqual(keys(f).slice(3), ["change-1", "review-1-1", "fix-1-1", "verify-1-1", "review-1-2"]);
  const k = byKey(f);
  assert.equal(k["fix-1-1"].resume, "run-change-1");
  assert.ok(!("gate" in k["fix-1-1"]));
  assert.match(k["fix-1-1"].task, /review-1-1\.md/);
  assert.equal(k["verify-1-1"].worktree, false);
  assert.equal(r.review, "/t/d/review-1-2.md");
  assert.equal(r.branch, "pi/h1");
  assert.equal(r.hypotheses[0].rounds, 2);
  assertSound(f);
}

// No hypotheses ends the run when the diagnosis cannot help.
{
  const f = fake({ hypothesize: { ok: false, hypotheses: [], problem: "only one hypothesis" } });
  const r = await run(f.runs, args);
  assert.ok(!keys(f).some((k) => k.startsWith("change-")));
  assert.equal(r.branch, null);
  assert.ok(r.open.length + r.decide.length > 0);
}
