/**
 * Split logic of the implement graph, against the real library. Run by
 * importing it; every assertion runs at import time and throws on failure.
 */
import assert from "node:assert/strict";
import { recipeLib } from "../lib/recipe-lib.mjs";
import { portOf } from "../runner/fake.mjs";
import { joinSpec, piecesStatus, reviewRange, splitItem, takePieces } from "./split.mjs";

const lib = recipeLib(portOf({ all: async () => [] }));

const parentOf = (over = {}) => {
  const t = {
    id: "a",
    spec: { id: "a", owns: ["lib", "a.nix"], est: 80000 },
    branch: "pi/a",
    worktree: "/wt/a",
    head: "head-a",
    base: "base-a",
    runId: "run-a",
    file: "/plan/tasks/a.md",
    level: 2,
    track: lib.handoffTrack(),
    state: "running",
    next: "split",
    ...over,
  };
  return t;
};
const piece = (id, over = {}) => ({ id, owns: ["lib/" + id], depends: [], est: 40000, file: "/split/tasks/" + id + ".md", ...over });
const gateOf = (tasks, over = {}) => ({ ok: true, tasks, ...over });

// splitItem
{
  const t = parentOf();
  const item = splitItem(lib, t, { dir: "/run", n: 1, note: "/run/note.md", limit: 50000, sizing: "/s.json", timeoutMs: 9 });
  assert.equal(item.agent, "planner");
  assert.equal(item.big, true);
  assert.equal(item.handoffOf, "run-a");
  assert.equal(item.handoffAs, "split");
  assert.equal(item.maxRuntimeMs, 9);
  assert.equal(item.output, "/run/split/a-1/planner.md");
  assert.equal(item.gate.command, "recipe-gate plan '/run/split/a-1' --repo '/wt/a' --limit 50000 --sizing '/s.json'");
  assert.match(item.task, /^Task file: \/plan\/tasks\/a\.md$/m);
  assert.match(item.task, /^Handoff note: \/run\/note\.md$/m);
  assert.match(item.task, /git diff base-a\.\.pi\/a/);
  assert.match(item.task, /^Files the pieces may own: lib, a\.nix$/m);
  assert.match(item.task, /ids start with a-\./);
}

// takePieces: a good split
{
  const t = parentOf();
  const r = takePieces(lib, t, gateOf([piece("a-1"), piece("a-2")]), { taken: ["a"] });
  assert.equal(r.ok, true);
  assert.equal(r.problem, null);
  assert.deepEqual(r.pieces.map((p) => p.id), ["a-1", "a-2"]);
  assert.equal(t.track.root.splits, 1);
  for (const p of r.pieces) {
    assert.equal(p.baseRef, "refs/heads/pi/a");
    assert.equal(p.base, "head-a");
    assert.equal(p.parent, "a");
    assert.equal(p.level, 2);
    assert.equal(p.next, "implement");
    assert.equal(p.track.piece, true);
    assert.equal(p.track.root, t.track.root);
    assert.equal(p.spec.id, p.id);
    assert.equal(p.file, "/split/tasks/" + p.id + ".md");
  }
}

// takePieces: each refusal names its problem and counts nothing
{
  const refused = (gate, pattern, over = {}) => {
    const t = parentOf();
    const r = takePieces(lib, t, gate, { taken: [], ...over });
    assert.equal(r.ok, false);
    assert.deepEqual(r.pieces, []);
    assert.match(r.problem, pattern);
    assert.equal(t.track.root.splits, 0);
  };
  refused(gateOf([piece("a-1")]), /fewer than two/);
  refused(gateOf([piece("a-1"), piece("b-2")]), /b-2 does not start with a-/);
  refused(gateOf([piece("a-1"), piece("a-2", { owns: ["other/x"] })]), /a-2 owns files outside/);
  refused(gateOf([piece("a-1"), piece("a-2", { depends: ["a-1"] })]), /a-2 depends on a-1/);
  refused(gateOf([piece("a-1"), piece("a-2", { est: 80000 })]), /a-2 is not estimated smaller/);
  refused(gateOf([piece("a-1"), piece("a-2")], { ok: false }), /plan gate/);
  refused(gateOf([piece("a-1"), piece("a-2")]), /a-2 is already taken/, { taken: ["a-2"] });
}

// a piece of a piece shares the root, so a third split is refused
{
  const t = parentOf();
  const first = takePieces(lib, t, gateOf([piece("a-1"), piece("a-2")]), { taken: [] });
  const inner = { ...parentOf({ id: "a-1", spec: first.pieces[0].spec }), ...first.pieces[0], branch: "pi/a-1", head: "head-1" };
  const second = takePieces(lib, inner, gateOf([piece("a-1-1", { est: 10000, owns: ["lib/a-1/x"] }), piece("a-1-2", { est: 10000, owns: ["lib/a-1/y"] })]), { taken: [] });
  assert.equal(second.ok, true);
  assert.equal(t.track.root.splits, 2);
  assert.equal(second.pieces[0].track.root, t.track.root);
  const info = { head: "h1", commits: 1, remainder: "more", firstContext: 1, budgetTokens: 100000 };
  const third = lib.afterHandoff(second.pieces[0].track, info);
  assert.equal(third.action, "relay", "the first handoff relays");
  second.pieces[0].track.relays = 2;
  const refusedSplit = lib.afterHandoff(second.pieces[0].track, { ...info, head: "h2", remainder: "other" });
  assert.equal(refusedSplit.action, "decide");
  assert.match(refusedSplit.reason, /split twice already/);
}

// piecesStatus
{
  const t = parentOf({ state: "split", next: "pieces" });
  const one = { id: "a-1", parent: "a", state: "running" };
  const two = { id: "a-2", parent: "a", state: "done" };
  const other = { id: "b", parent: null, state: "set_aside" };
  const byId = { a: t, "a-1": one, "a-2": two, b: other };
  assert.deepEqual(piecesStatus(t, byId), { status: "waiting", piece: null });
  one.state = "done";
  assert.deepEqual(piecesStatus(t, byId), { status: "ready", piece: null });
  one.state = "set_aside";
  const blocked = piecesStatus(t, byId);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.piece, one);
  assert.equal(piecesStatus(parentOf({ id: "c" }), byId).status, "waiting", "no pieces is not ready");
}

// joinSpec and reviewRange
{
  const t = parentOf();
  const one = { id: "a-1", parent: "a", state: "done", branch: "pi/a-1" };
  const two = { id: "a-2", parent: "a", state: "done", branch: "pi/a-2" };
  const spec = joinSpec(t, "/run", 2, "integ", { a: t, "a-1": one, "a-2": two });
  assert.deepEqual(spec, {
    scope: "a",
    kind: "task",
    id: "a",
    branch: "integ-split-a-2",
    tips: [one, two],
    onto: "refs/heads/pi/a",
    dir: "/run/split/a-2/join",
  });
  assert.equal(reviewRange(t, "integ-split-a-2"), "base-a..integ-split-a-2");
}
