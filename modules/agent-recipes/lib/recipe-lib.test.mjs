/**
 * Tests of the shared recipe library alone, against a fake `runs`. The
 * library is loaded the way the installed workflow is: as the leading part of
 * a script run in an AsyncFunction with `runs`, `args` and `emit`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const lib = fs.readFileSync(new URL("./recipe-lib.js", import.meta.url), "utf8");
assert.ok(!/\basync\b/.test(lib), "workflow scripts may not define async functions");
assert.ok(!/setTimeout/.test(lib), "the sandbox has no setTimeout");
assert.ok(!/^\s*(import|export)\b/m.test(lib), "the sandbox has no modules");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const names = "node,port,launch,one,retryItem,stoppedItself,subjectOf,troubleOf,diagnose,rankAndCap,sourcesFound,searchItem,extractItem,board,receipt,healed,decide,tally,sibling";
const load = (runs, emit) => new AsyncFunction("runs", "args", "emit", `${lib}\nreturn { ${names} };`)(runs, {}, emit);

function fake(respond) {
  const batches = [];
  return {
    batches,
    runs: {
      all: async (items) => {
        batches.push(items);
        return items.map((item) => respond(item));
      },
    },
  };
}
const ok = (key, structuredOutput) => ({ ok: true, runId: `run-${key}`, structuredOutput });
const failed = (key, error) => ({ ok: false, runId: `run-${key}`, error });

// node(): the shape, the self-gate line, selfGate:false, optional fields.
{
  const L = await load(fake(() => null).runs);
  const gated = L.node("k", "writer", ["Do it.", "Output: /t/o.md"], "/t/o.md", {
    gate: "recipe-gate x '/t/o.md'",
    timeoutMs: 5,
    gateTimeoutMs: 7,
    worktree: "wt",
    resume: "run-1",
  });
  assert.deepEqual(gated, {
    key: "k",
    agent: "writer",
    task: "Do it.\nOutput: /t/o.md\nWhen the file is written, run `recipe-gate x '/t/o.md'`; if it reports a problem, fix the file and run it again before you finish, unless your report says blocked or failed.",
    output: "/t/o.md",
    outputMode: "file-only",
    maxRuntimeMs: 5,
    gate: { command: "recipe-gate x '/t/o.md'", output: "json", timeoutMs: 7 },
    worktree: "wt",
    resume: "run-1",
  });

  const quiet = L.node("k", "writer", ["Do it."], "/t/o.md", { gate: "recipe-gate integrate", selfGate: false });
  assert.equal(quiet.task, "Do it.");
  assert.deepEqual(quiet.gate, { command: "recipe-gate integrate", output: "json" });

  const bare = L.node("k", "writer", ["Do it."], "/t/o.md");
  assert.deepEqual(Object.keys(bare), ["key", "agent", "task", "output", "outputMode"]);
  const lines = ["a"];
  L.node("k", "w", lines, "/o", { gate: "g" });
  assert.deepEqual(lines, ["a"], "the caller's lines are not modified");
}

// retryItem(): every mention of the output moves, including the gate command
// and the self-gate line; resume follows the failed run.
{
  const L = await load(fake(() => null).runs);
  const item = L.node("w", "writer", ["Output: /t/d/a.md"], "/t/d/a.md", { gate: "recipe-gate x '/t/d/a.md'", resume: "run-old" });
  const copy = L.retryItem(item, { runId: "run-failed" });
  assert.equal(copy.key, "w-retry");
  assert.equal(copy.output, "/t/d/a.retry.md");
  assert.equal(copy.task, item.task.replaceAll("/t/d/a.md", "/t/d/a.retry.md"));
  assert.equal(copy.gate.command, "recipe-gate x '/t/d/a.retry.md'");
  assert.equal(copy.resume, "run-failed");
  assert.equal(L.retryItem(item, {}).resume, "run-old");
  assert.equal(item.output, "/t/d/a.md", "the original is untouched");
  assert.ok(!("resume" in L.retryItem(L.node("w", "writer", ["x"], "/t/d/a.md"), { runId: "r" })));
}

// launch(): a failed child runs once more beside its file; a child that
// stopped itself does not; one() returns the single result; children count.
{
  const f = fake((item) => (item.key === "a" ? failed("a", "engine") : item.key === "b" ? failed("b", "worker reported as not-satisfied") : ok(item.key)));
  const L = await load(f.runs);
  const items = ["a", "b", "c"].map((k) => L.node(k, "w", ["Output: /t/" + k + ".md"], "/t/" + k + ".md"));
  const results = await L.launch(items);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["a", "b", "c"], ["a-retry"]]);
  assert.deepEqual(results.map((r) => [r.ok, r.file]), [[true, "/t/a.retry.md"], [false, "/t/b.md"], [true, "/t/c.md"]]);
  assert.equal(L.tally.children, 4);
  const single = await L.one(L.node("c", "w", ["x"], "/t/c2.md"));
  assert.equal(single.file, "/t/c2.md");
  assert.equal(L.tally.children, 5);
}

// diagnose(): at most two diagnoses per subject, then a decision; the same
// diagnosis twice is a decision; ids keep subjects apart.
{
  const f = fake((item) => ok(item.key, { ok: true, action: "retry", reason: item.key === "diagnose-t1-1" ? "Same!" : "Reason " + item.key }));
  const L = await load(f.runs);
  const trouble = L.troubleOf("step", "it broke", ["/e", null], ["retry", "decide"]);

  const s = L.subjectOf(null);
  const first = await L.diagnose(s, trouble, "/t", ["Goal: g"], "the step", 100);
  assert.equal(first.action, "retry");
  assert.equal(first.file, "/t/diagnosis-1.md");
  const second = await L.diagnose(s, trouble, "/t", ["Goal: g"], "the step", 100);
  assert.equal(second.file, "/t/diagnosis-2.md");
  const third = await L.diagnose(s, trouble, "/t", ["Goal: g"], "the step", 100);
  assert.equal(third, null);
  assert.equal(f.batches.length, 2, "no third diagnosis child");
  assert.deepEqual(L.healed.map((h) => [h.id, h.step, h.action]), [[null, "step", "retry"], [null, "step", "retry"]]);
  assert.deepEqual(L.decide, [{ id: null, step: "step", question: "it broke (still failing after 2 recoveries)", diagnosis: "/t/diagnosis-2.md" }]);

  const brief = f.batches[0][0];
  assert.equal(brief.gate.command, "recipe-gate diagnosis '/t/diagnosis-1.md' --allow 'retry,decide'");
  assert.match(brief.task, /Evidence: \/e$/m);
  assert.match(f.batches[1][0].task, /Earlier diagnosis: \/t\/diagnosis-1\.md/);

  const t1 = L.subjectOf("t1");
  const g1 = await L.diagnose(t1, trouble, "/t", [], "s", 100);
  assert.equal(g1.file, "/t/diagnosis-t1-1.md");
  assert.equal(g1.reason, "Same!");
  const g2 = await L.diagnose(t1, trouble, "/t", [], "s", 100);
  assert.equal(g2.file, "/t/diagnosis-t1-2.md");
  assert.equal(L.healed.at(-1).id, "t1");
}
{
  const f = fake((item) => ok(item.key, { ok: true, action: "retry", reason: "The  engine restarted." }));
  const L = await load(f.runs);
  const trouble = L.troubleOf("step", "it broke", [], ["retry", "decide"]);
  const s = L.subjectOf("x");
  assert.ok(await L.diagnose(s, trouble, "/t", [], "s", 1));
  assert.equal(await L.diagnose(s, trouble, "/t", [], "s", 1), null);
  assert.match(L.decide[0].question, /the same diagnosis came back twice/);
  assert.equal(L.decide[0].id, "x");
  assert.equal(L.healed.length, 1);
}
// A diagnosis that asks for a person, and one that cannot be read.
{
  const L = await load(fake((item) => ok(item.key, { ok: true, action: "decide", reason: "pick one" })).runs);
  const s = L.subjectOf(null);
  assert.equal(await L.diagnose(s, L.troubleOf("a", "bad", [], ["decide"]), "/t", [], "s", 1), null);
  assert.deepEqual(L.decide, [{ id: null, step: "a", question: "pick one", diagnosis: "/t/diagnosis-1.md" }]);
  const M = await load(fake((item) => ok(item.key, { ok: false, problem: "no action" })).runs);
  assert.equal(await M.diagnose(M.subjectOf(null), M.troubleOf("a", "bad", [], ["decide"]), "/t", [], "s", 1), null);
  assert.match(M.decide[0].question, /bad; the diagnosis could not be read: no action/);
}

// rankAndCap(): primary first within an angle, one per angle in turn,
// repeats dropped, stops at the limit.
{
  const L = await load(fake(() => null).runs);
  const u = (angle, n, kind) => ({ url: `https://x/${angle}${n}`, angle, kind });
  const found = [u("a", 1, "secondary"), u("a", 2, "primary"), u("b", 1, "secondary"), u("a", 1, "primary"), u("b", 2, "secondary"), u("c", 1, "secondary")];
  assert.deepEqual(L.rankAndCap(found, 10).map((x) => x.url.slice(-2)), ["a2", "b1", "c1", "a1", "b2"]);
  assert.deepEqual(L.rankAndCap(found, 4).map((x) => x.url.slice(-2)), ["a2", "b1", "c1", "a1"]);
  assert.deepEqual(L.rankAndCap([], 3), []);
}

// sourcesFound(), board() and receipt() share the counters.
{
  const emits = [];
  const L = await load(fake(() => null).runs, (v) => emits.push(v));
  const open = [];
  const angles = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const searches = [
    ok("a", { ok: true, urls: [{ url: "u1", kind: "primary", why: "w" }, { url: "u2", kind: "secondary", why: "w" }] }),
    ok("b", { ok: false, urls: [] }),
    failed("c", "boom"),
  ];
  assert.deepEqual(L.sourcesFound(angles, searches, { u2: true }, open), [{ url: "u1", kind: "primary", why: "w", angle: "a" }]);
  assert.deepEqual(open, ["search b: no sources listed", "search c: boom"]);
  assert.equal(L.searchItem("g", { id: "a", question: "Q?" }, "/t/s.md", 9).gate.command, "recipe-gate urls '/t/s.md'");
  assert.equal(L.extractItem("e", "g", "u", "a", "/p", "/t/e.md", "half", 9).gate.command, "recipe-gate extract '/t/e.md'");
  L.tally.children = 3;
  assert.deepEqual(L.receipt({ output: "o" }), { output: "o", healed: [], decide: [], children: 3 });
  assert.equal(emits.at(-1).stage, "finished");
  assert.equal(emits.at(-1).children, 3);
  assert.doesNotThrow(() => L.board("x", {}));
}

console.log("recipe library: ok");
