/**
 * Behaviour tests for the budget trigger, the handoff end and the call kinds.
 * Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { END_TURNS, HANDOFF_TIMEOUT_MS, budgetTrigger, callKind, handoffEnd, valveRecord } from "./budget.mjs";

assert.equal(HANDOFF_TIMEOUT_MS, 600_000);
assert.equal(END_TURNS, 6);

const NOTE = "/work/wt/note.md";
const LOCAL_NOTE = path.resolve("note.md");
const BUDGET = { tokens: 100000, reserve: 30000, action: "commit" };

const read = { tool: "read", path: "src/a.js" };
const writeNote = { tool: "write", path: "note.md", content: "handoff: x" };
const commitCall = { tool: "bash", command: "git add -A && git commit -m x" };

// A tool-call turn at the budget fires once, with the context of that turn.
for (const action of ["commit", "unread", "stop"]) {
  const trigger = budgetTrigger({ tokens: 100000, reserve: 30000, action });
  assert.equal(trigger.observe({ context: 99_999, calls: [read] }), null, `${action}: below budget`);
  assert.deepEqual(trigger.observe({ context: 100_000, calls: [read] }), { tokens: 100_000 }, `${action}: at the budget`);
  assert.equal(trigger.observe({ context: 110_000, calls: [read] }), null, `${action}: fires once`);
}

// A final reply never fires, even over the budget.
{
  const trigger = budgetTrigger(BUDGET);
  assert.equal(trigger.observe({ context: 150_000, calls: [] }), null);
  assert.equal(trigger.observe({ context: 150_000 }), null);
}

// No budget, or no positive budget.tokens, never fires.
for (const b of [null, undefined, {}, { tokens: 0 }, { tokens: -100000 }, { tokens: "100000" }, { tokens: Number.NaN }]) {
  const trigger = budgetTrigger(b);
  assert.equal(trigger.observe({ context: 900_000, calls: [read] }), null);
  assert.equal(trigger.observe({ context: 900_000, calls: [read] }), null);
}

// stop() keeps the trigger quiet, as it must after a thrash ending.
{
  const trigger = budgetTrigger(BUDGET);
  trigger.stop();
  assert.equal(trigger.observe({ context: 150_000, calls: [read] }), null);
}

// callKind: a write or edit of the output path is the note, nothing else is.
{
  const o = { output: NOTE, action: "stop" };
  assert.equal(callKind({ tool: "write", path: NOTE }, o), "note");
  assert.equal(callKind({ tool: "edit", path: NOTE }, o), "note");
  for (const call of [
    { tool: "write", path: "other.md" },
    { tool: "write", path: "/work/note.md" },
    { tool: "edit", path: "src/a.js" },
    { tool: "write" },
    { tool: "read", path: NOTE },
    { tool: "bash", command: "git commit -m x" },
  ]) {
    assert.equal(callKind(call, o), null, JSON.stringify(call));
  }
  assert.equal(callKind({ tool: "write", path: NOTE }, { output: null, action: "stop" }), null, "no output path");
}

// A relative path resolves against the current directory.
{
  const o = { output: LOCAL_NOTE, action: "stop" };
  assert.equal(callKind({ tool: "write", path: "note.md" }, o), "note");
  assert.equal(callKind({ tool: "write", path: "sub/../note.md" }, o), "note");
  assert.equal(callKind({ tool: "write", path: NOTE }, o), null, "an absolute path elsewhere");
}

// callKind: a bash call is a commit only when the action is commit and the
// command runs git commit as the harness's match does.
for (const command of [
  "git commit -m x",
  "git add -A && git commit -m x",
  'git -C wt commit -m "a; b"',
  "git add -A;\ngit commit -m 'a && b'\n",
  'git commit -m "line one\nline two; rm -rf x"',
  'git commit -m "a" ; rm -rf x',
  'git commit -m "$(rm x)"',
  "git commit -m `rm x`",
]) {
  assert.equal(callKind({ tool: "bash", command }, { output: NOTE, action: "commit" }), "commit", command);
}
for (const command of [
  "cd wt && git status",
  "git log --oneline",
  "rm -rf x",
  "git push",
  "git add -A && git push",
  "git status | sh",
  "git log > /tmp/x",
  "git status &",
  "git -c core.pager=x log",
  "cd wt",
  "",
]) {
  assert.equal(callKind({ tool: "bash", command }, { output: NOTE, action: "commit" }), null, command);
}
assert.equal(callKind({ tool: "bash" }, { output: NOTE, action: "commit" }), null, "no command");
for (const action of ["unread", "stop"]) {
  assert.equal(callKind(commitCall, { output: NOTE, action }), null, action);
}

// session drives the trigger and the end the way the harnesses will: the
// trigger sees every completed turn of the first run; from the turn after the
// firing one, the end sees the calls with their results.
function session(b) {
  const trigger = budgetTrigger(b);
  const state = { fired: null, ended: 0 };
  let end = null;
  let n = 0;
  const turn = (size, calls, { fail = false } = {}) => {
    const withIds = calls.map((call) => ({ ...call, id: `call-${++n}` }));
    const results = withIds.map((call) => ({ id: call.id, isError: fail }));
    const hit = trigger.observe({ context: size, calls: withIds });
    if (hit) {
      state.fired = hit.tokens;
      end = handoffEnd(b, { firedTokens: hit.tokens, output: LOCAL_NOTE });
      return;
    }
    if (end && end.observe({ context: size, calls: withIds, results })) state.ended += 1;
  };
  return { state, turn };
}

// Commit, then note: it ends once, at the end of the note turn.
{
  const { state, turn } = session(BUDGET);
  turn(140_000, [read]);
  assert.equal(state.fired, 140_000);
  turn(145_000, [commitCall]);
  assert.equal(state.ended, 0, "commit alone is not enough");
  turn(150_000, [writeNote]);
  assert.equal(state.ended, 1);
  turn(151_000, [read]);
  assert.equal(state.ended, 1, "ends once");
}

// Note, then commit, and both in one turn, end at the turn that completes the pair.
{
  const a = session(BUDGET);
  a.turn(100_000, [read]);
  a.turn(101_000, [writeNote]);
  assert.equal(a.state.ended, 0, "note alone is not enough for commit");
  a.turn(102_000, [commitCall]);
  assert.equal(a.state.ended, 1);

  const b = session(BUDGET);
  b.turn(100_000, [read]);
  b.turn(101_000, [commitCall, writeNote]);
  assert.equal(b.state.ended, 1);
}

// For unread and stop the note write alone ends it.
for (const action of ["unread", "stop"]) {
  const s = session({ tokens: 100000, reserve: 30000, action });
  s.turn(100_000, [read]);
  s.turn(101_000, [read]);
  assert.equal(s.state.ended, 0, action);
  s.turn(102_000, [writeNote]);
  assert.equal(s.state.ended, 1, action);
}

// A failed note write, a write elsewhere and a failed commit do not count.
{
  const s = session({ tokens: 100000, reserve: 30000, action: "unread" });
  s.turn(100_000, [read]);
  s.turn(101_000, [writeNote], { fail: true });
  s.turn(102_000, [{ tool: "write", path: "other.md", content: "x" }]);
  assert.equal(s.state.ended, 0);
  const c = session(BUDGET);
  c.turn(100_000, [read]);
  c.turn(101_000, [writeNote]);
  c.turn(102_000, [commitCall], { fail: true });
  assert.equal(c.state.ended, 0);
}

// Without a note it ends when the context grew by a full reserve counted from
// the firing size; a reserve that is not positive never does.
{
  const s = session(BUDGET);
  s.turn(100_000, [read]);
  s.turn(129_999, [read]);
  assert.equal(s.state.ended, 0);
  s.turn(130_000, [read]);
  assert.equal(s.state.ended, 1);
  s.turn(160_000, [read]);
  assert.equal(s.state.ended, 1, "ends once");

  for (const b of [{ tokens: 100000, reserve: 0, action: "stop" }, { tokens: 100000, action: "stop" }]) {
    const z = session(b);
    z.turn(100_000, [read]);
    z.turn(300_000, [read]);
    assert.equal(z.state.ended, 0);
  }
}

// Or after six turns with tool calls, whatever the size; a turn without calls
// never ends it and is not counted.
{
  const s = session(BUDGET);
  s.turn(100_000, [read]);
  for (let i = 0; i < END_TURNS; i += 1) {
    assert.equal(s.state.ended, 0, `after ${i} turns`);
    s.turn(100_100, [read]);
  }
  assert.equal(s.state.ended, 1);

  const f = session(BUDGET);
  f.turn(100_000, [read]);
  for (let i = 0; i < END_TURNS + 2; i += 1) f.turn(200_000, []);
  assert.equal(f.state.ended, 0, "final replies never end it");

  const m = session(BUDGET);
  m.turn(100_000, [read]);
  m.turn(200_000, []);
  for (let i = 0; i < END_TURNS - 1; i += 1) m.turn(100_100, [read]);
  assert.equal(m.state.ended, 0, "the final reply was not counted");
  m.turn(100_100, [read]);
  assert.equal(m.state.ended, 1, "the sixth tool-call turn ends it");
}

// valveRecord is what the harness reports as its valve state.
{
  assert.deepEqual(valveRecord(BUDGET, 140_000, false), { fired: true, tokens: 140_000, budget: 100000, action: "commit", ended: false });
  assert.deepEqual(valveRecord({ tokens: 50000, action: "stop" }, 51_000, true), { fired: true, tokens: 51_000, budget: 50000, action: "stop", ended: true });
}

console.log("budget tests passed");
