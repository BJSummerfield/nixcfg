/**
 * Tests of the shared recipe library alone, against a fake `runs`.
 */
import assert from "node:assert/strict";
import { recipeLib } from "./recipe-lib.mjs";

const load = (runs, emit) =>
  recipeLib({
    runMany: (items) => runs.all(items),
    runOne: (item) => runs.all([item]).then((r) => r[0]),
    emit: (view) => {
      if (typeof emit === "function") emit(view);
    },
  });

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

// Big items: small ones run together first, then each big one alone, in
// order; a failed big item retries alone; one() of a big item uses runOne.
{
  const calls = [];
  const respond = (item) => (item.key === "b1" || item.key === "b2" || item.key === "b2-retry" ? failed(item.key, "engine") : ok(item.key));
  const L = await load({
    all: async (items) => {
      calls.push(items.map((i) => i.key));
      return items.map(respond);
    },
  });
  L.port.runOne = async (item) => {
    calls.push("one:" + item.key);
    return respond(item);
  };
  const mk = (k, big) => L.node(k, "w", ["Output: /t/" + k + ".md"], "/t/" + k + ".md", { big });
  assert.equal(mk("b1", true).big, true);
  assert.ok(!("big" in mk("s1", false)));
  assert.equal(L.retryItem(mk("b1", true), {}).big, true);
  const results = await L.launch([mk("b1", true), mk("s1"), mk("b2", true), mk("s2")]);
  assert.deepEqual(calls, [["s1", "s2"], "one:b1", "one:b1-retry", "one:b2", "one:b2-retry"]);
  assert.deepEqual(results.map((r) => [r.ok, r.file]), [[true, "/t/b1.retry.md"], [true, "/t/s1.md"], [false, "/t/b2.retry.md"], [true, "/t/s2.md"]]);
  assert.equal(L.tally.children, 6);
  calls.length = 0;
  const single = await L.one(mk("c", true));
  assert.deepEqual(calls, ["one:c"]);
  assert.equal(single.file, "/t/c.md");
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
  const located = [
    ok("a", { ok: true, paths: [{ path: "src/a.js", range: { start: 5, end: 40 }, kind: "primary", why: "w" }, { path: "src/b.js", range: null, kind: "secondary", why: "w" }] }),
    ok("b", { ok: false, paths: [] }),
    failed("c", "boom"),
  ];
  const open2 = [];
  assert.deepEqual(L.pathsFound(angles, located, { "src/b.js": true }, open2), [
    { url: "src/a.js:5-40", path: "src/a.js", range: { start: 5, end: 40 }, kind: "primary", why: "w", angle: "a" },
  ]);
  assert.deepEqual(open2, ["locate b: no files listed", "locate c: boom"]);
  const loc = L.locateItem("g", { id: "a", question: "Q?" }, "/r", "/t/l.md", 9);
  assert.equal(loc.agent, "locator");
  assert.match(loc.task, /^Goal: g\nAngle: a\nQuestion: Q\?\nRepository: \/r\nOutput: \/t\/l\.md\n/);
  assert.equal(loc.gate.command, "recipe-gate paths '/t/l.md'");
  const fe = L.extractFileItem("e", "g", "/r/src/a.js", { start: 5, end: 40 }, "a", "/t/e.md", 9);
  assert.equal(fe.agent, "extractor");
  assert.match(fe.task, /^Goal: g\nFile: \/r\/src\/a\.js\nRange: 5-40\nAngle: a\nOutput: \/t\/e\.md\n/);
  assert.equal(fe.gate.command, "recipe-gate extract '/t/e.md'");
  assert.ok(!/Range:/.test(L.extractFileItem("e", "g", "/r/x", null, "a", "/t/e.md", 9).task));
  L.tally.children = 3;
  assert.deepEqual(L.receipt({ output: "o" }), { output: "o", healed: [], decide: [], children: 3 });
  assert.equal(emits.at(-1).stage, "finished");
  assert.equal(emits.at(-1).children, 3);
  assert.doesNotThrow(() => L.board("x", {}));
}

console.log("recipe library: ok");

// gatherSources(): search and/or locate, rank and cap, extract.
{
  const search = (urls) => ok("search-q", { ok: true, urls: urls.map((u, i) => ({ url: u, kind: i === 0 ? "primary" : "secondary", why: "w" })) });
  const spec = { goal: "G", question: "Q?", id: "q", dir: "/t", repo: "/r", childMs: 9 };

  {
    const urls = ["u1", "u2", "u3", "u4", "u5"];
    const f = fake((item) => {
      if (item.key === "search-q") return search(urls);
      return item.key === "extract-q-2" ? ok(item.key, { ok: false, reason: "thin" }) : ok(item.key, { ok: true, bytes: 5 });
    });
    const L = await load(f.runs);
    const out = await L.gatherSources(spec);
    assert.equal(f.batches.length, 2);
    assert.deepEqual(f.batches[0].map((i) => i.key), ["search-q"]);
    assert.equal(f.batches[0][0].output, "/t/research/q/search.md");
    assert.deepEqual(f.batches[1].map((i) => i.key), ["extract-q-1", "extract-q-2", "extract-q-3"]);
    assert.equal(f.batches[1][0].output, "/t/research/q/extract-1.md");
    assert.ok(f.batches[1][0].task.includes("Page: /t/research/q/page-1.md"));
    assert.ok(f.batches[1][0].task.includes("URL: u1"));
    assert.deepEqual(out.files, ["/t/research/q/extract-1.md", "/t/research/q/extract-3.md"]);
    assert.deepEqual(out.sources, [{ url: "u1", status: "ok" }, { url: "u2", status: "rejected" }, { url: "u3", status: "ok" }]);
    assert.deepEqual(out.open, ["source u2: rejected"]);
  }

  {
    const f = fake((item) => {
      if (item.key === "locate-q") return ok(item.key, { ok: true, paths: [{ path: "src/a.js", kind: "primary", why: "w", range: { start: 1, end: 9 } }] });
      return ok(item.key, { ok: true, bytes: 1 });
    });
    const L = await load(f.runs);
    const out = await L.gatherSources({ ...spec, source: "repo" });
    assert.deepEqual(f.batches[0].map((i) => i.key), ["locate-q"]);
    assert.ok(f.batches[1][0].task.includes("File: /r/src/a.js"));
    assert.ok(f.batches[1][0].task.includes("Range: 1-9"));
    assert.deepEqual(out.files, ["/t/research/q/extract-1.md"]);
  }

  {
    const f = fake((item) => {
      if (item.key === "search-q") return search(["u1"]);
      if (item.key === "locate-q") return ok(item.key, { ok: true, paths: [{ path: "p.js", kind: "primary", why: "w" }] });
      return failed(item.key, "boom");
    });
    const L = await load(f.runs);
    const out = await L.gatherSources({ ...spec, source: "both" });
    assert.deepEqual(f.batches[0].map((i) => i.key).sort(), ["locate-q", "search-q"]);
    assert.equal(f.batches[1].length, 2);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.sources.map((s) => s.status), ["failed", "failed"]);
  }

  {
    const f = fake((item) => ok(item.key, { ok: true, urls: [] }));
    const L = await load(f.runs);
    const out = await L.gatherSources(spec);
    assert.deepEqual(out.files, []);
    assert.ok(out.open.includes("no sources were found"));
    assert.equal(f.batches.length, 1);
  }

  {
    const f = fake(() => null);
    const L = await load(f.runs);
    assert.deepEqual((await L.gatherSources({ ...spec, source: "ftp" })).open, ["source must be web, repo or both"]);
    assert.deepEqual((await L.gatherSources({ ...spec, source: "both", repo: "" })).open, ["a repository source needs the repo argument"]);
    assert.equal(f.batches.length, 0);
  }
}

// Two libraries do not share healing, decision or child counts.
{
  const A = await load(fake(() => ok("x")).runs);
  const B = await load(fake(() => ok("x")).runs);
  await A.one(A.node("k", "w", ["t"], "/t/k.md"));
  A.askDecision(A.subjectOf(""), "s", "q", null);
  assert.equal(A.tally.children, 1);
  assert.equal(B.tally.children, 0);
  assert.equal(A.decide.length, 1);
  assert.equal(B.decide.length, 0);
  assert.notEqual(A.healed, B.healed);
}
