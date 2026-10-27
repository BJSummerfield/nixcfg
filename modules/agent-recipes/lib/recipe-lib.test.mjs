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

// searcher and extractor have no shell: their gated briefs carry no self-gate
// line; the locator keeps it.
{
  const L = await load(fake(() => null).runs);
  const angle = { id: "a", question: "Q?" };
  for (const item of [L.searchItem("g", angle, "/t/s.md", 9), L.extractItem("e", "g", "u", "a", "/p", "/t/e.md", "", 9), L.extractFileItem("ef", "g", "/r/x", null, "a", "/t/ef.md", 9)]) {
    assert.ok(!item.task.includes("run `recipe-gate"), item.key);
    assert.ok(item.gate, item.key);
  }
  const loc = L.locateItem("g", angle, "/r", "/t/l.md", 9);
  assert.match(loc.task, /When the file is written, run `recipe-gate paths '\/t\/l\.md'`/);
  assert.equal(L.searchItem("g", angle, "/t/s.md", 9).agent, "searcher");
}

// retryItem(): every mention of the output moves, including the gate command
// and the self-gate line.
{
  const L = await load(fake(() => null).runs);
  const item = L.node("w", "writer", ["Output: /t/d/a.md"], "/t/d/a.md", { gate: "recipe-gate x '/t/d/a.md'" });
  const copy = L.retryItem(item, { runId: "run-failed" });
  assert.equal(copy.key, "w-retry");
  assert.equal(copy.output, "/t/d/a.retry.md");
  assert.equal(copy.task, item.task.replaceAll("/t/d/a.md", "/t/d/a.retry.md"));
  assert.equal(copy.gate.command, "recipe-gate x '/t/d/a.retry.md'");
  assert.equal(item.output, "/t/d/a.md", "the original is untouched");
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

// A done child whose output the gate rejected after the port filled it from
// the reply is retried once, and the retry names the file the child must
// write; the retry itself, an over-cap verdict and a rejected file are not
// retried; without the flag the retry brief is unchanged.
{
  const reply = (key, gate) => ({ ok: true, status: "done", runId: `run-${key}`, outputFromReply: true, structuredOutput: gate });

  const f = fake((item) => reply(item.key, { ok: false }));
  const L = await load(f.runs);
  const results = await L.launch([L.searchItem("g", { id: "a", question: "Q?" }, "/t/w.md", 9)]);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["search-a"], ["search-a-retry"]]);
  assert.equal(f.batches[1][0].output, "/t/w.retry.md");
  assert.match(f.batches[1][0].task, /The previous attempt did not write the output file\. Write it to \/t\/w\.retry\.md\.$/);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].file, "/t/w.retry.md");
  assert.equal(L.tally.children, 2, "the reply-filled retry is not retried again");

  const g = fake((item) => reply(item.key, { ok: false }));
  const M = await load(g.runs);
  const single = await M.one(M.node("b", "writer", ["Output: /t/b.md"], "/t/b.md", { gate: "recipe-gate x '/t/b.md'", big: true }));
  assert.deepEqual(g.batches.map((b) => b.map((i) => i.key)), [["b"], ["b-retry"]]);
  assert.equal(g.batches[1][0].output, "/t/b.retry.md");
  assert.match(g.batches[1][0].task, /The previous attempt did not write the output file\. Write it to \/t\/b\.retry\.md\.$/);
  assert.equal(single.ok, true);
  assert.equal(single.file, "/t/b.retry.md");
  assert.equal(M.tally.children, 2, "the big reply-filled retry is not retried again");

  const c = fake((item) => (item.key === "w" ? reply("w", { ok: false, over_cap: true }) : ok(item.key)));
  const C = await load(c.runs);
  await C.launch([C.node("w", "writer", ["Output: /t/w.md"], "/t/w.md", { gate: "recipe-gate x '/t/w.md'" })]);
  assert.deepEqual(c.batches.map((b) => b.map((i) => i.key)), [["w"]], "an over-cap verdict is not retried");
  assert.equal(C.tally.children, 1);

  const d = fake((item) => (item.key === "w" ? { ok: true, status: "done", runId: "run-w", outputFromReply: false, structuredOutput: { ok: false } } : ok(item.key)));
  const D = await load(d.runs);
  await D.launch([D.node("w", "writer", ["Output: /t/w.md"], "/t/w.md", { gate: "recipe-gate x '/t/w.md'" })]);
  assert.deepEqual(d.batches.map((b) => b.map((i) => i.key)), [["w"]], "a rejected file is not retried");
  assert.equal(D.tally.children, 1);

  const h = fake((item) => (item.key === "w" ? failed("w", "engine") : ok(item.key)));
  const N = await load(h.runs);
  await N.launch([N.node("w", "writer", ["Output: /t/w.md"], "/t/w.md", { gate: "recipe-gate x '/t/w.md'" })]);
  assert.equal(h.batches[1][0].task, h.batches[0][0].task.replaceAll("/t/w.md", "/t/w.retry.md"), "no flag: the retry brief is the moved brief");
}

// A gate result without an ok field is no rejection: a reviewer with a clean
// verdict run from its reply runs once.
{
  const f = fake((item) =>
    item.key === "rev" ? { ok: true, status: "done", runId: "run-rev", outputFromReply: true, structuredOutput: { asked: "yes", sound: "yes", clean: true, verdict: "clean" } } : ok(item.key),
  );
  const L = await load(f.runs);
  const single = await L.one(L.node("rev", "reviewer", ["Review."], "/t/rev.md", { gate: "recipe-gate verdict '/t/rev.md'", big: true }));
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["rev"]], "a clean verdict without ok is not retried");
  assert.equal(single.file, "/t/rev.md");
  assert.equal(L.tally.children, 1);
}

// A gate reason on a rejected reply-filled result reaches the retry brief.
{
  const f = fake((item) => reply(item.key, item.key === "search-a" ? { ok: false, reason: "no urls" } : { ok: false }));
  function reply(key, gate) {
    return { ok: true, status: "done", runId: `run-${key}`, outputFromReply: true, structuredOutput: gate };
  }
  const L = await load(f.runs);
  const results = await L.launch([L.searchItem("g", { id: "a", question: "Q?" }, "/t/w.md", 9)]);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["search-a"], ["search-a-retry"]]);
  assert.ok(f.batches[1][0].task.includes("/t/w.retry.md"), "the retry brief names the output path");
  assert.ok(f.batches[1][0].task.includes("no urls"), "the retry brief carries the gate reason");
  assert.equal(results[0].file, "/t/w.retry.md");
  assert.equal(L.tally.children, 2);
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
  assert.doesNotMatch(f.batches[1][0].task, /Earlier diagnosis/);

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
  assert.match(fe.task, /^Goal: g\nFile: \/r\/src\/a\.js\nRange: 5-40\nAngle: a\nOutput: \/t\/e\.md$/);
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

// Handoff rules: relay first, split when the relay made no progress, started
// late or the relays ran out, decide on repeats and on exhausted splits.
{
  const L = await load(fake(() => null).runs);
  assert.deepEqual(L.handoffLimits, { MAX_RELAYS: 2, MAX_SPLITS: 2, START_FRACTION: 0.5 });
  assert.equal(L.handedOff({ handoff: { line: "handoff: x" } }).line, "handoff: x");
  assert.equal(L.handedOff({ handoff: null }), null);
  assert.equal(L.handedOff({}), null);
  assert.equal(L.remainderOf({ line: "handoff: Tests for the parser; wire-up left!" }), "tests for the parser wire up left");
  const empty = { line: "handoff: ended by the context valve before its note", empty: true };
  assert.notEqual(L.remainderOf(empty, "aaa111"), L.remainderOf(empty, "bbb222"));
  assert.equal(L.remainderOf(empty, "aaa111"), L.remainderOf(empty, "AAA111"));
  assert.equal(L.remainderOf({ line: "handoff: x", empty: false }, "aaa111"), "x");

  const info = (over) => Object.assign({ head: "h1", commits: 2, firstContext: 10000, budgetTokens: 100000, remainder: "r1" }, over);

  const first = L.handoffTrack();
  assert.deepEqual(first, { relays: 0, heads: [], remainders: [], piece: false, root: { splits: 0 } });
  assert.equal(L.afterHandoff(first, info()).action, "relay");
  assert.deepEqual(first.heads, ["h1"]);
  assert.deepEqual(first.remainders, ["r1"]);

  const same = L.handoffTrack();
  L.afterHandoff(same, info());
  same.relays++;
  const stalled = L.afterHandoff(same, info({ remainder: "r2" }));
  assert.equal(stalled.action, "split");
  assert.match(stalled.reason, /committed nothing/);

  const late = L.handoffTrack();
  L.afterHandoff(late, info());
  late.relays++;
  assert.equal(L.afterHandoff(late, info({ head: "h2", remainder: "r2", firstContext: 50000 })).action, "relay", "exactly half is not above half");
  assert.equal(L.afterHandoff(late, info({ head: "h3", remainder: "r3", firstContext: 50001 })).action, "split");
  const unknown = L.handoffTrack();
  L.afterHandoff(unknown, info());
  unknown.relays++;
  assert.equal(L.afterHandoff(unknown, info({ head: "h2", remainder: "r2", firstContext: undefined, budgetTokens: null })).action, "relay");

  const spent = L.handoffTrack();
  spent.relays = 2;
  assert.equal(L.afterHandoff(spent, info({ head: "h9", remainder: "r9" })).action, "split");

  const echo = L.handoffTrack();
  L.afterHandoff(echo, info());
  const again = L.afterHandoff(echo, info({ head: "h2" }));
  assert.deepEqual(again, { action: "decide", reason: "the same remainder came back" });
  const blank = L.handoffTrack();
  L.afterHandoff(blank, info({ remainder: "" }));
  assert.equal(L.afterHandoff(blank, info({ remainder: "", head: "h2" })).action, "relay", "an empty remainder never repeats");

  const root = L.handoffTrack();
  const piece = L.handoffTrack(root);
  assert.equal(piece.piece, true);
  assert.equal(piece.root, root.root);
  assert.equal(L.afterHandoff(piece, info({ commits: 0 })).reason, "nothing committed after a split");
  assert.equal(L.afterHandoff(root, info({ commits: 0, remainder: "q" })).action, "relay", "a task of the plan with no commits is not a piece");

  const shared = L.handoffTrack();
  shared.root.splits = 2;
  shared.relays = 2;
  const escalated = L.afterHandoff(shared, info({ remainder: "z" }));
  assert.equal(escalated.action, "decide");
  assert.match(escalated.reason, /split twice already/);
  const neighbour = L.handoffTrack(shared);
  neighbour.relays = 2;
  assert.equal(L.afterHandoff(neighbour, info({ remainder: "y" })).action, "decide", "pieces share the splits of their task");
}

// relayLines(): with and without a note.
{
  const L = await load(fake(() => null).runs);
  assert.deepEqual(L.relayLines("/t/note.md", "task-a"), [
    "Continue this task from the handoff note at /t/note.md; the branch task-a holds the committed work, so build on it and do not redo it.",
  ]);
  assert.deepEqual(L.relayLines(null, "task-a"), ["Continue this task; the branch task-a holds the committed work, so build on it and do not redo it."]);
}

// beginRelay(): the relay state and one counted relay when a track is given;
// a null track is not counted; clearRelay() undoes the state.
{
  const L = await load(fake(() => null).runs);
  const state = { relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null };
  const track = L.handoffTrack();
  L.beginRelay(state, track, { branch: "task-a", note: "/t/note.md", from: "run-1" });
  assert.deepEqual(state, { relayRef: "refs/heads/task-a", relayBranch: "task-a", relayNote: "/t/note.md", handoffFrom: "run-1" });
  assert.equal(track.relays, 1);
  L.clearRelay(state);
  assert.deepEqual(state, { relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null });
  L.beginRelay(state, null, { branch: "task-a" });
  assert.deepEqual(state, { relayRef: "refs/heads/task-a", relayBranch: "task-a", relayNote: null, handoffFrom: null });
  assert.equal(track.relays, 1, "a relay without a track is not counted");
}

// relayBriefLines(): the relay's brief lines when there is a relay, none
// when there is not.
{
  const L = await load(fake(() => null).runs);
  const state = { relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null };
  assert.deepEqual(L.relayBriefLines(state), []);
  L.beginRelay(state, null, { branch: "task-a", note: "/t/note.md", from: "run-1" });
  assert.deepEqual(L.relayBriefLines(state), L.relayLines("/t/note.md", "task-a"));
  L.clearRelay(state);
  assert.deepEqual(L.relayBriefLines(state), []);
}

// stampRelay(): the relay branch and the stamp once; without a relay the
// fallback base and no stamps.
{
  const L = await load(fake(() => null).runs);
  const state = { relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null };
  L.beginRelay(state, L.handoffTrack(), { branch: "task-a", from: "run-1" });
  const first = { key: "k1" };
  assert.equal(L.stampRelay(first, state, "base-ref"), first);
  assert.deepEqual([first.baseRef, first.handoffOf, first.handoffAs], ["refs/heads/task-a", "run-1", "relay"]);
  assert.equal(state.handoffFrom, null, "the stamp is used once");
  const second = { key: "k2" };
  L.stampRelay(second, state, "base-ref");
  assert.equal(second.baseRef, "refs/heads/task-a");
  assert.ok(!("handoffOf" in second) && !("handoffAs" in second), "a second item is not stamped");
  const fresh = { relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null };
  const bare = { key: "k3" };
  L.stampRelay(bare, fresh, "base-ref");
  assert.equal(bare.baseRef, "base-ref");
  assert.ok(!("handoffOf" in bare) && !("handoffAs" in bare));
}

// reportHandoff(): a handoff status in the gate report is a handoff, other
// reports are not.
{
  const L = await load(fake(() => null).runs);
  assert.deepEqual(L.reportHandoff({ report: { status: "handoff", why: "ran out of context" } }, "/t/r.md"), {
    line: "handoff: ran out of context",
    unread: [],
    note: "/t/r.md",
    empty: false,
  });
  assert.equal(L.reportHandoff({ report: { status: "handoff" } }, "/t/r.md").line, "handoff: ", "no why is a blank line");
  assert.equal(L.reportHandoff({ report: { status: "done", why: "w" } }, "/t/r.md"), null);
  assert.equal(L.reportHandoff({}, "/t/r.md"), null);
  assert.equal(L.reportHandoff(null, "/t/r.md"), null);
}

// handoffCall(): the same decision as the equivalent direct afterHandoff call.
{
  const L = await load(fake(() => null).runs);
  const handoff = { line: "handoff: left the parser tests", unread: [], note: "/t/r.md", empty: false };
  const g = { head: "h1", commits: 3 };
  const a = L.handoffTrack();
  const b = L.handoffTrack();
  const direct = L.afterHandoff(a, { head: g.head, commits: g.commits, firstContext: 900, budgetTokens: 100000, remainder: L.remainderOf(handoff, g.head) });
  const via = L.handoffCall(b, handoff, g, { firstContext: 900, budgetTokens: 100000 });
  assert.deepEqual(via, direct);
  assert.equal(via.action, "relay");
  assert.deepEqual(b, a, "the track moves the same way");
}

// acceptSplit(): an accepted split counts once, a refused one not at all.
{
  const L = await load(fake(() => null).runs);
  const piece = (id) => ({ id: id, owns: ["lib/a.mjs"], depends: [], est: 40000, file: "/t/" + id + ".md" });
  const o = { parentId: "a", parentEst: 80000, parentOwns: ["lib"], taken: [] };
  const track = L.handoffTrack();
  const good = L.acceptSplit(track, { ok: true, tasks: [piece("a-1"), piece("a-2")] }, o);
  assert.equal(good.ok, true);
  assert.equal(track.root.splits, 1);
  const refused = L.acceptSplit(track, { ok: false, tasks: [piece("a-1")] }, o);
  assert.equal(refused.ok, false);
  assert.match(refused.problem, /plan gate/);
  assert.equal(track.root.splits, 1, "a refused split is not counted");
}

// splitPlanItem(): a big planner node with the plan gate over the worktree.
{
  const L = await load(fake(() => null).runs);
  const o = {
    key: "split-a-1",
    splitDir: "/t/split/a-1",
    parentId: "a",
    taskFile: "/t/tasks/a.md",
    note: "/t/note.md",
    branch: "task-a",
    base: "abc123",
    worktree: "/w/it's",
    owns: ["x.mjs", "y"],
    limit: 50000,
    sizing: "/s.json",
    timeoutMs: 9,
    handoffOf: "run-1",
  };
  const item = L.splitPlanItem(o);
  assert.equal(item.agent, "planner");
  assert.equal(item.big, true);
  assert.equal(item.maxRuntimeMs, 9);
  assert.equal(item.output, "/t/split/a-1/planner.md");
  assert.equal(item.handoffOf, "run-1");
  assert.equal(item.handoffAs, "split");
  assert.equal(item.gate.command, "recipe-gate plan '/t/split/a-1' --repo '/w/it'\\''s' --limit 50000 --sizing '/s.json'");
  assert.match(item.task, /^Task file: \/t\/tasks\/a\.md$/m);
  assert.match(item.task, /^Handoff note: \/t\/note\.md$/m);
  assert.match(item.task, /^Branch: task-a$/m);
  assert.match(item.task, /git diff abc123\.\.task-a/);
  assert.match(item.task, /^Files the pieces may own: x\.mjs, y$/m);
  assert.match(item.task, /ids start with a-\./);
  assert.match(item.task, /depends: none/);
  assert.match(item.task, /\/t\/split\/a-1\/tasks\/<id>\.md/);

  const bare = L.splitPlanItem(Object.assign({}, o, { note: null, limit: undefined, sizing: undefined, owns: null, handoffOf: undefined }));
  assert.ok(!/Handoff note/.test(bare.task));
  assert.equal(bare.gate.command, "recipe-gate plan '/t/split/a-1' --repo '/w/it'\\''s'");
  assert.ok(!("handoffOf" in bare));
  assert.equal(bare.handoffAs, "split");
}

// piecesFrom(): each rule alone, then a good split.
{
  const L = await load(fake(() => null).runs);
  const piece = (id, over) => Object.assign({ id: id, owns: ["lib/a.mjs"], depends: [], est: 40000, file: "/t/" + id + ".md" }, over);
  const gate = (tasks, over) => Object.assign({ ok: true, tasks: tasks }, over);
  const o = { parentId: "a", parentEst: 80000, parentOwns: ["lib"], taken: ["a-old"] };
  const good = L.piecesFrom(gate([piece("a-1"), piece("a-2", { owns: ["lib/b.mjs"] })]), o);
  assert.equal(good.ok, true);
  assert.deepEqual(good.pieces.map((p) => p.id), ["a-1", "a-2"]);
  assert.equal(good.problem, null);

  const bad = (g, over) => L.piecesFrom(g, Object.assign({}, o, over));
  assert.match(bad(gate([piece("a-1"), piece("a-2")], { ok: false })).problem, /plan gate/);
  assert.match(bad(null).problem, /plan gate/);
  assert.match(bad(gate([piece("a-1")])).problem, /fewer than two/);
  assert.match(bad(gate([piece("a-1"), piece("b-2")])).problem, /b-2 does not start with a-/);
  assert.match(bad(gate([piece("a-1"), piece("a-old")])).problem, /a-old is already taken/);
  assert.match(bad(gate([piece("a-1"), piece("a-2", { depends: ["a-1"] })])).problem, /a-2 depends on a-1/);
  assert.match(bad(gate([piece("a-1"), piece("a-2", { owns: ["other/c.mjs"] })])).problem, /a-2 owns files outside/);
  assert.match(bad(gate([piece("a-1"), piece("a-2", { owns: ["library/c.mjs"] })])).problem, /a-2 owns files outside/, "a shared name prefix is not inside");
  assert.match(bad(gate([piece("a-1"), piece("a-2", { est: 80000 })])).problem, /a-2 is not estimated smaller/);
  assert.equal(bad(gate([piece("a-1"), piece("a-2", { owns: ["other/c.mjs"] })]), { parentOwns: null }).ok, true, "no parent paths: not checked");
  assert.equal(bad(gate([piece("a-1"), piece("a-2")]), { parentEst: null }).ok, true);
  assert.equal(bad(gate([piece("a-1"), piece("a-old")]), { taken: new Set(["a-old"]) }).ok, false, "a set of taken ids works too");
}

// Unread input: a synthesizer that read one file of three runs two parts and
// one merge; the merge is the result and sees only the note and the parts.
{
  const handoff = { line: "handoff: read a only; b and c left", unread: ["/in/b.md", "/in/c.md", "/in/d.md"], note: "/t/syn.md", empty: false };
  const f = fake((item) => {
    if (item.key === "syn") return Object.assign(ok("syn", { ok: true }), { handoff });
    return ok(item.key, { ok: true, from: item.key });
  });
  const L = await load(f.runs);
  const item = L.node("syn", "synthesizer", ["Synthesize the inputs.", "Output: /t/syn.md"], "/t/syn.md", { gate: "recipe-gate synth '/t/syn.md'" });
  const result = await L.one(item);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["syn"], ["syn-part-1", "syn-part-2"], ["syn-merge"]]);
  const [p1, p2] = f.batches[1];
  assert.equal(p1.output, "/t/syn.part-1.md");
  assert.equal(p2.output, "/t/syn.part-2.md");
  assert.equal(p1.gate.command, "recipe-gate synth '/t/syn.part-1.md'");
  assert.match(p1.task, /When the file is written, run `recipe-gate synth '\/t\/syn\.part-1\.md'`/);
  assert.ok(!p1.task.includes("Output: /t/syn.md"));
  assert.match(p1.task, /^Output: \/t\/syn\.part-1\.md$/m);
  assert.match(p1.task, /This continues an earlier synthesizer that handed off; its notes are at \/t\/syn\.md\. Read only these inputs, which it did not reach: \/in\/b\.md, \/in\/c\.md$/m);
  assert.match(p2.task, /did not reach: \/in\/d\.md$/m);
  assert.deepEqual([p1.handoffOf, p1.handoffAs, p1.splitDepth], ["run-syn", "split", 1]);

  const merge = f.batches[2][0];
  assert.equal(merge.agent, "synthesizer");
  assert.equal(merge.output, "/t/syn.merged.md");
  assert.equal(merge.gate.command, "recipe-gate synth '/t/syn.merged.md'");
  assert.equal(merge.splitDepth, 2);
  assert.deepEqual([merge.handoffOf, merge.handoffAs], ["run-syn", "split"]);
  assert.match(merge.task, /^Merge the partial results of earlier synthesizer runs\. Read only the handoff note \/t\/syn\.md and these part files: \/t\/syn\.part-1\.md, \/t\/syn\.part-2\.md; do not open the original inputs\.$/m);
  assert.match(merge.task, /Write the whole result, in the format of those files, to \/t\/syn\.merged\.md\./);
  assert.ok(!merge.task.includes("Synthesize the inputs."));
  assert.ok(!merge.task.includes("/in/"));
  assert.match(merge.task, /run `recipe-gate synth '\/t\/syn\.merged\.md'`/);

  assert.equal(result.ok, true);
  assert.equal(result.file, "/t/syn.merged.md");
  assert.equal(result.structuredOutput.from, "syn-merge");
  assert.equal(L.tally.children, 4, "the first child, two parts and the merge");
}

// A reviewer through a big item: one unread path is one part, parts and merge
// run one at a time.
{
  const calls = [];
  const handoff = { line: "handoff: partial", unread: ["/in/x.diff"], note: null, empty: true };
  const f = fake((item) => (item.key === "rev" ? Object.assign(ok("rev"), { handoff }) : ok(item.key, { ok: true })));
  const L = await load({
    all: async (items) => {
      calls.push(items.map((i) => i.key));
      return f.runs.all(items);
    },
  });
  const item = L.node("rev", "reviewer", ["Review.", "Write the report to /t/rev.md"], "/t/rev.md", { gate: "recipe-gate verdict '/t/rev.md'", big: true });
  const result = await L.launch([item]);
  assert.deepEqual(calls, [["rev"], ["rev-part-1"], ["rev-merge"]]);
  assert.equal(result[0].file, "/t/rev.merged.md");
  assert.ok(f.batches[1][0].big, "a part of a big item is big");
  assert.match(f.batches[1][0].task, /handed off before writing notes\. Read only these inputs, which it did not reach: \/in\/x\.diff$/m);
  assert.match(f.batches[2][0].task, /^Merge the partial results of earlier reviewer runs\. Read only these part files: \/t\/rev\.part-1\.md; do not open/m);
}

// A part that hands off with a shorter list is split again; the sub-merge
// stands in for the part.
{
  const f = fake((item) => {
    if (item.key === "syn") return Object.assign(ok("syn"), { handoff: { line: "handoff: a", unread: ["/i/1", "/i/2", "/i/3", "/i/4"], note: "/t/syn.md", empty: false } });
    if (item.key === "syn-part-1") return Object.assign(ok(item.key), { handoff: { line: "handoff: b", unread: ["/i/2"], note: item.output, empty: false } });
    return ok(item.key, { ok: true });
  });
  const L = await load(f.runs);
  const item = L.node("syn", "synthesizer", ["Synthesize.", "Output: /t/syn.md"], "/t/syn.md", { gate: "recipe-gate synth '/t/syn.md'" });
  const result = await L.one(item);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [
    ["syn"],
    ["syn-part-1", "syn-part-2"],
    ["syn-part-1-part-1"],
    ["syn-part-1-merge"],
    ["syn-merge"],
  ]);
  const sub = f.batches[2][0];
  assert.equal(sub.output, "/t/syn.part-1.part-1.md");
  assert.equal(sub.splitDepth, 2);
  assert.match(sub.task, /^Synthesize\.$/m);
  assert.equal((sub.task.match(/This continues an earlier/g) || []).length, 1, "only the newest input list is in the brief");
  assert.match(sub.task, /its notes are at \/t\/syn\.part-1\.md\. Read only these inputs, which it did not reach: \/i\/2$/m);
  assert.match(f.batches[3][0].task, /part files: \/t\/syn\.part-1\.part-1\.md;/);
  assert.match(f.batches[4][0].task, /part files: \/t\/syn\.part-1\.merged\.md, \/t\/syn\.part-2\.md;/);
  assert.equal(result.ok, true);
  assert.equal(result.file, "/t/syn.merged.md");
}

// A part that hands off with the same list, or at the split limit, fails the
// step; so does a failed part.
{
  const withHandoff = (key, unread) => Object.assign(ok(key), { handoff: { line: "handoff: " + key, unread: unread, note: null, empty: true } });
  const make = async (respond) => {
    const f = fake(respond);
    const L = await load(f.runs);
    const item = L.node("syn", "synthesizer", ["Synthesize.", "Output: /t/syn.md"], "/t/syn.md", { gate: "recipe-gate synth '/t/syn.md'" });
    return { f, result: await L.one(item) };
  };

  const same = await make((item) => {
    if (item.key === "syn") return withHandoff("syn", ["/i/1", "/i/2"]);
    if (item.key === "syn-part-1") return withHandoff(item.key, ["/i/1"]);
    return ok(item.key);
  });
  assert.equal(same.result.ok, false);
  assert.match(same.result.error, /part syn-part-1 failed: a part handed off again without reading any of its input/);
  assert.deepEqual(same.f.batches.map((b) => b.map((i) => i.key)), [["syn"], ["syn-part-1", "syn-part-2"]]);

  const deep = await make((item) => {
    if (item.key === "syn") return withHandoff("syn", ["/i/1", "/i/2", "/i/3", "/i/4"]);
    if (item.key === "syn-part-1") return withHandoff(item.key, ["/i/2"]);
    if (item.key === "syn-part-1-part-1") return withHandoff(item.key, ["/i/2"]);
    return ok(item.key);
  });
  assert.equal(deep.result.ok, false);
  assert.match(deep.result.error, /a part handed off at the split limit/);
  assert.ok(!deep.f.batches.some((b) => b.some((i) => /merge/.test(i.key))), "no merge after a failed part");

  const lost = await make((item) => {
    if (item.key === "syn") return withHandoff("syn", ["/i/1", "/i/2"]);
    if (item.key === "syn-part-2" || item.key === "syn-part-2-retry") return failed(item.key, "engine");
    return ok(item.key);
  });
  assert.equal(lost.result.ok, false);
  assert.match(lost.result.error, /part syn-part-2 failed: engine/);
  assert.deepEqual(lost.f.batches.map((b) => b.map((i) => i.key)), [["syn"], ["syn-part-1", "syn-part-2"], ["syn-part-2-retry"]]);
}

// A merge that hands off fails the step and is not split again.
{
  const handoff = { line: "handoff: x", unread: ["/i/1", "/i/2"], note: null, empty: true };
  const f = fake((item) => (item.key === "syn" || item.key === "syn-merge" ? Object.assign(ok(item.key), { handoff }) : ok(item.key)));
  const L = await load(f.runs);
  const result = await L.one(L.node("syn", "synthesizer", ["Synthesize.", "Output: /t/syn.md"], "/t/syn.md"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "the merge handed off");
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["syn"], ["syn-part-1", "syn-part-2"], ["syn-merge"]]);
  assert.ok(!("gate" in f.batches[2][0]), "an item without a gate stays without one");
}

// A reviewer or synthesizer handoff without an unread list is a failure; an
// implementer or scout handoff is returned untouched.
{
  const handoff = { line: "handoff: x", unread: [], note: "/t/r.md", empty: false };
  const f = fake((item) => Object.assign(ok(item.key, { ok: true, verdict: "invalid" }), { handoff }));
  const L = await load(f.runs);
  for (const agent of ["reviewer", "synthesizer"]) {
    const r = await L.one(L.node(agent, agent, ["x"], "/t/" + agent + ".md"));
    assert.deepEqual(r, { ok: false, error: "handed off without listing unread input", runId: "run-" + agent, file: "/t/" + agent + ".md" });
  }
  for (const agent of ["implementer", "scout", undefined]) {
    const r = await L.one(L.node("k-" + agent, agent, ["x"], "/t/" + agent + ".md"));
    assert.equal(r.ok, true);
    assert.deepEqual(r.handoff, handoff);
    assert.equal(r.file, "/t/" + agent + ".md");
  }
  assert.equal(f.batches.length, 5, "nothing was continued");
}

// A retried child is continued under its retry output.
{
  const f = fake((item) => {
    if (item.key === "syn") return failed("syn", "engine");
    if (item.key === "syn-retry") return Object.assign(ok(item.key), { handoff: { line: "handoff: x", unread: ["/i/1"], note: item.output, empty: false } });
    return ok(item.key, { ok: true });
  });
  const L = await load(f.runs);
  const result = await L.launch([L.node("syn", "synthesizer", ["Synthesize.", "Output: /t/syn.md"], "/t/syn.md")]);
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["syn"], ["syn-retry"], ["syn-retry-part-1"], ["syn-retry-merge"]]);
  assert.equal(f.batches[2][0].output, "/t/syn.retry.part-1.md");
  assert.equal(result[0].file, "/t/syn.retry.merged.md");
}

// A child cut short by a stop ends the graph instead of reaching the retry or the caller.
{
  const f = fake((item) => (item.key === "b" ? { ...failed(item.key, "run stopped"), status: "aborted" } : ok(item.key, undefined)));
  const L = await load(f.runs);
  await assert.rejects(L.launch([L.node("a", "writer", ["x"], "/t/a.md"), L.node("b", "writer", ["x"], "/t/b.md")]), { name: "RunStopped" });
  assert.deepEqual(f.batches.map((b) => b.map((i) => i.key)), [["a", "b"]]);
  await assert.rejects(L.one(L.node("b", "writer", ["x"], "/t/b.md")), { name: "RunStopped" });
}
