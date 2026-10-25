/**
 * Behaviour tests for the budget valve. Run by `nix flake check`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses; they cannot prove pi's own semantics (that `followUp`
 * lands in the same run), which were verified by reading the installed
 * 0.86.1 source instead.
 */
import assert from "node:assert/strict";
import budgetValve from "./budget-valve.js";

function harness(env = {}) {
  const handlers = {};
  const sent = [];
  const entries = [];
  const pi = {
    appendEntry: (customType, data) => {
      entries.push({ customType, data });
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: async (message, options) => {
      sent.push({ message, options });
    },
  };
  budgetValve(pi, env);
  return {
    sent,
    entries,
    handlers,
    turnEnd: (message, ctx) => handlers.turn_end({ type: "turn_end", message }, ctx),
    toolExecutionEnd: (event) => handlers.tool_execution_end({ type: "tool_execution_end", ...event }),
    sessionCompact: () => handlers.session_compact({ type: "session_compact" }),
    toolCall: (event, ctx) => handlers.tool_call({ type: "tool_call", ...event }, ctx),
  };
}

const assistant = (usage, stopReason = "stop", content) => ({
  role: "assistant",
  stopReason,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
  ...(content ? { content } : {}),
});

// A truncated turn is recovered with a followUp, once; a second cut-off ends
// with a tool-permitting steer; a third sends nothing (sent.length stays 2).
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].message.customType, "budget-valve-truncated");
  assert.equal(h.sent[0].options.deliverAs, "followUp");
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.match(h.sent[0].message.content[0].text, /one tool call per section/);
  assert.equal(h.sent[1].message.customType, "budget-valve-final");
  assert.equal(h.sent[1].options.deliverAs, "steer");
  assert.match(h.sent[1].message.content[0].text, /FAILED: output limit/);
}

// Without a budget in the environment, context size is pi's business: no turn
// is interrupted for being large, and nothing is ever aborted.
{
  const h = harness();
  let aborted = 0;
  const ctx = { abort: () => (aborted += 1), getContextUsage: () => ({ tokens: 300_000, contextWindow: 400_000 }) };
  await h.turnEnd(assistant({ totalTokens: 70_000 }), ctx);
  await h.turnEnd(assistant({ totalTokens: 90_000 }, "toolUse"), ctx);
  await h.turnEnd(assistant({ totalTokens: 95_000 }, "toolUse"), ctx);
  assert.equal(h.sent.length, 0, "no handoff request at any size");
  assert.equal(aborted, 0, "no abort at any size");
  assert.equal(h.entries.length, 0);
  assert.equal(h.toolCall({ toolName: "bash", input: { command: "rm -rf x" } }, ctx), undefined);
}

// A child compacts like any other session: the valve does not listen for it
// through the compaction hook.
{
  const h = harness();
  assert.equal(h.handlers.session_before_compact, undefined);
}

// No recovery when the window is nearly full: the recovery turn would inherit the
// same dead ceiling. The run is left to pi, not aborted. The final notice (state 1)
// has no headroom check.
{
  const h = harness();
  let aborted = 0;
  const ctx = {
    abort: () => (aborted += 1),
    getContextUsage: () => ({ contextWindow: 98_304, tokens: 93_000 }),
  };
  await h.turnEnd(assistant({ totalTokens: 93_000 }, "length"), ctx);
  assert.equal(h.sent.length, 0);
  assert.equal(aborted, 0);
}

// A skipped first recovery does not use a state.
{
  const h = harness();
  const full = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 93_000 }) };
  const roomy = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 40_000 }) };
  await h.turnEnd(assistant({ totalTokens: 93_000 }, "length"), full);
  await h.turnEnd(assistant({ totalTokens: 40_000 }, "length"), roomy);
  assert.equal(h.sent.length, 1);
}

// Non-assistant turn_end payloads are ignored.
{
  const h = harness();
  await h.turnEnd({ role: "user", stopReason: "length", usage: { totalTokens: 30_000 } });
  await h.turnEnd(undefined);
  assert.equal(h.sent.length, 0);
}

// A "length" stop that pi would also treat as recoverable overflow
// (output short of the model's unclamped maxTokens, near a full window) is
// already covered by the state-0 headroom gate above: a queued valve message
// drains before agent_end, so whichever of the two acts first simply
// pre-empts the other, and there is no double handling to guard against. A
// near-full ctx (contextWindow and tokens close to full, as the clamp
// produces) confirms state 0 sends nothing here, same as the plain
// near-full-window case already covered.
{
  const h = harness();
  const ctx = { getContextUsage: () => ({ contextWindow: 98_304, tokens: 94_208 }) };
  await h.turnEnd(assistant({ output: 16_384, totalTokens: 94_208 }, "length"), ctx);
  assert.equal(h.sent.length, 0);
}

// Compaction thrash: three session_compact events with no intervening edit or
// write end the run with a tool-blocking steer; a fourth sends nothing more.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 0);
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-thrash");
  assert.equal(h.sent[0].options.deliverAs, "steer");
  assert.match(h.sent[0].message.content[0].text, /FAILED: compaction thrash/);
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
}

// A successful edit/write between compactions resets the count; an isError
// write does not; a read does not.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.toolExecutionEnd({ toolName: "write", isError: false });
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 0, "the reset absorbed the first two");
  await h.toolExecutionEnd({ toolName: "write", isError: true });
  await h.toolExecutionEnd({ toolName: "read", isError: false });
  await h.sessionCompact();
  assert.equal(h.sent.length, 1, "neither the failed write nor the read reset the count");
}

// Before the thrash ending, tool_call is unblocked. After it: blocked but not
// terminal, then terminal once a tool-bearing turn_end has passed.
{
  const h = harness();
  assert.equal(h.toolCall(), undefined);
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  const first = h.toolCall();
  assert.equal(first.block, true);
  assert.equal(first.terminate, false);
  await h.turnEnd(assistant({}, "stop", [{ type: "toolCall" }]));
  const second = h.toolCall();
  assert.equal(second.block, true);
  assert.equal(second.terminate, true);
}

// After the thrash ending, a length turn sends no further valve message.
{
  const h = harness();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  assert.equal(h.sent.length, 1);
}

// Handoff at the context budget. `session` drives a valve like pi does: each
// turn runs the tool_call handler per call, then turn_end with the results.
const NOTE = "/work/wt/note.md";
const budgetEnv = (action) => ({
  RECIPE_BUDGET_TOKENS: "100000",
  RECIPE_BUDGET_RESERVE: "30000",
  RECIPE_HANDOFF_ACTION: action,
  RECIPE_OUTPUT: NOTE,
  RECIPE_ROLE: "worker",
});

function session(action = "commit") {
  const h = harness(budgetEnv(action));
  const state = { tokens: null, aborted: 0 };
  const ctx = {
    cwd: "/work/wt",
    abort: () => (state.aborted += 1),
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: 221_184 }),
  };
  let n = 0;
  // calls: [toolName, input] pairs. fail marks every result as an error.
  const turn = async (size, calls, { fail = false } = {}) => {
    state.tokens = size;
    const decisions = [];
    const blocks = [];
    const results = [];
    for (const [toolName, input] of calls) {
      n += 1;
      const id = `call-${n}`;
      const decision = h.toolCall({ toolCallId: id, toolName, input }, ctx);
      decisions.push(decision);
      blocks.push({ type: "toolCall", id, name: toolName, arguments: input });
      results.push({ role: "toolResult", toolCallId: id, toolName, isError: fail || decision?.block === true });
    }
    const message = assistant({ totalTokens: size }, "toolUse", blocks);
    await h.handlers.turn_end({ type: "turn_end", message, toolResults: results }, ctx);
    return decisions;
  };
  return { h, state, ctx, turn };
}

const read = ["read", { path: "src/a.js" }];
const writeNote = ["write", { path: "note.md", content: "handoff: x" }];
const commitCall = ["bash", { command: "git add -A && git commit -m x" }];

// Nothing but the budget variable matters: other RECIPE_* variables alone never fire.
{
  const h = harness({ RECIPE_ROLE: "worker", RECIPE_OUTPUT: NOTE, RECIPE_HANDOFF_ACTION: "commit" });
  const ctx = { getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_000_000 }) };
  await h.turnEnd(assistant({}, "toolUse", [{ type: "toolCall", id: "a" }]), ctx);
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.length, 0);
  assert.equal(h.toolCall({ toolCallId: "a", toolName: "bash", input: { command: "rm -rf x" } }, ctx), undefined);
}

// A tool-call turn at the budget fires once per action, with that action's text.
for (const [action, pattern] of [
  ["commit", /Commit everything you changed with git first[\s\S]*Done, Left and Watch for/],
  ["unread", /Directly under that first line, before the partial result[\s\S]*`unread: <path>`[\s\S]*Repeat the unread lines/],
  ["stop", /Write what you have found so far/],
]) {
  const { h, turn } = session(action);
  await turn(99_999, [read]);
  assert.equal(h.sent.length, 0, `${action}: below budget`);
  await turn(100_000, [read]);
  await turn(110_000, [read]);
  assert.equal(h.sent.length, 1, `${action}: fires once`);
  const [{ message, options }] = h.sent;
  assert.equal(message.customType, "budget-valve-handoff");
  assert.equal(options.deliverAs, "steer");
  assert.equal(options.triggerTurn, true);
  const text = message.content[0].text;
  assert.match(text, pattern);
  assert.match(text, /handoff: <what is done; what is left>/);
  assert.ok(text.includes(NOTE), "names the output path");
  assert.ok(text.includes("100000"), "names the budget");
  assert.deepEqual(h.entries, [
    {
      customType: "budget-valve",
      data: { kind: "handoff", role: "worker", action, budget: 100000, reserve: 30000, tokens: 100_000 },
    },
  ]);
}

// A final reply never fires, even over the budget.
{
  const { h, ctx, state } = session();
  state.tokens = 150_000;
  await h.turnEnd(assistant({ totalTokens: 150_000 }, "stop", [{ type: "text" }]), ctx);
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.length, 0);
}

// Unknown context size falls back to the message's usage; a tool-call block
// counts even when the stop reason does not say so.
{
  const { h, ctx, state } = session();
  state.tokens = null;
  await h.turnEnd(assistant({ input: 60_000, output: 10_000, cacheRead: 29_999 }, "toolUse"), ctx);
  assert.equal(h.sent.length, 0, "99,999 from the parts");
  await h.turnEnd(assistant({ totalTokens: 100_000 }, "stop", [{ type: "toolCall", id: "z" }]), ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.entries[0].data.tokens, 100_000);
}

// After firing for commit: only the output file and git are allowed.
{
  const { h, ctx, turn } = session("commit");
  const call = (toolName, input) => h.toolCall({ toolCallId: "p", toolName, input }, ctx);
  assert.equal(call("bash", { command: "rm -rf x" }), undefined, "nothing is blocked before firing");
  await turn(100_000, [read]);
  for (const ok of [
    ["write", { path: "note.md", content: "x" }],
    ["write", { path: "/work/wt/note.md", content: "x" }],
    ["write", { path: "sub/../note.md", content: "x" }],
    ["edit", { path: "note.md", edits: [] }],
    ["bash", { command: "git add -A && git commit -m x" }],
    ["bash", { command: 'git -C wt commit -m "a; b"' }],
    ["bash", { command: "cd wt && git status" }],
    ["bash", { command: "git add -A;\ngit commit -m 'a && b'\n" }],
    ["bash", { command: 'git commit -m "line one\nline two; rm -rf x"' }],
    ["bash", { command: "git log --oneline" }],
  ]) {
    assert.equal(call(...ok), undefined, JSON.stringify(ok));
  }
  for (const bad of [
    ["write", { path: "other.md", content: "x" }],
    ["write", { path: "/work/note.md", content: "x" }],
    ["edit", { path: "src/a.js", edits: [] }],
    ["write", { content: "x" }],
    ["read", { path: "note.md" }],
    ["bash", { command: "rm -rf x" }],
    ["bash", { command: "git push" }],
    ["bash", { command: "git add -A && git push" }],
    ["bash", { command: 'git commit -m "a" ; rm -rf x' }],
    ["bash", { command: "git status | sh" }],
    ["bash", { command: "git log > /tmp/x" }],
    ["bash", { command: 'git commit -m "$(rm x)"' }],
    ["bash", { command: "git commit -m `rm x`" }],
    ["bash", { command: "git status &" }],
    ["bash", { command: "git -c core.pager=x log" }],
    ["bash", { command: "git commit -m 'unterminated" }],
    ["bash", { command: "cd wt" }],
    ["bash", { command: "" }],
    ["bash", {}],
  ]) {
    const decision = call(...bad);
    assert.equal(decision?.block, true, JSON.stringify(bad));
    assert.match(decision.reason, /handing off/);
  }
}

// For unread and stop only the output file is allowed, git is not.
for (const action of ["unread", "stop"]) {
  const { h, ctx, turn } = session(action);
  await turn(100_000, [read]);
  const call = (toolName, input) => h.toolCall({ toolCallId: "p", toolName, input }, ctx);
  assert.equal(call("write", { path: "note.md", content: "x" }), undefined);
  assert.equal(call("bash", { command: "git commit -m x" })?.block, true);
  assert.equal(call("bash", { command: "git status" })?.block, true);
}

// terminate stays false for the first four turns after firing, then turns true.
{
  const { h, ctx, turn } = session();
  await turn(100_000, [read]);
  const probe = () => h.toolCall({ toolCallId: "p", toolName: "read", input: {} }, ctx);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(probe().terminate, false, `before post-fire turn ${i + 1} ends`);
    await turn(100_100, [read]);
  }
  assert.equal(probe().block, true);
  assert.equal(probe().terminate, true);
}

// The firing turn never aborts, even when it is already past budget + reserve.
{
  const { state, h, turn } = session();
  await turn(140_000, [read]);
  assert.equal(h.sent.length, 1);
  assert.equal(state.aborted, 0);
  await turn(140_500, [read]);
  assert.equal(state.aborted, 0, "reserve counts from where the valve fired");
}

// Commit, then note: the child is ended once, at the end of the note turn.
{
  const { state, h, turn } = session("commit");
  await turn(140_000, [read]);
  await turn(145_000, [commitCall]);
  assert.equal(state.aborted, 0, "commit alone is not enough");
  await turn(150_000, [writeNote]);
  assert.equal(state.aborted, 1);
  assert.deepEqual(h.entries.at(-1), { customType: "budget-valve", data: { kind: "ended", tokens: 150_000, turns: 2 } });
  await turn(151_000, [read]);
  assert.equal(state.aborted, 1, "ended once");
  assert.equal(h.entries.length, 2);
}

// Note, then commit, and both in one turn, end at the turn that completes the pair.
{
  const a = session("commit");
  await a.turn(100_000, [read]);
  await a.turn(101_000, [writeNote]);
  assert.equal(a.state.aborted, 0, "note alone is not enough for commit");
  await a.turn(102_000, [commitCall]);
  assert.equal(a.state.aborted, 1);

  const b = session("commit");
  await b.turn(100_000, [read]);
  await b.turn(101_000, [commitCall, writeNote]);
  assert.equal(b.state.aborted, 1);
}

// For unread and stop the note write alone ends the child.
for (const action of ["unread", "stop"]) {
  const { state, turn } = session(action);
  await turn(100_000, [read]);
  await turn(101_000, [read]);
  assert.equal(state.aborted, 0);
  await turn(102_000, [writeNote]);
  assert.equal(state.aborted, 1, action);
}

// A failed note write, a blocked write elsewhere and a failed commit do not count.
{
  const { state, turn } = session("unread");
  await turn(100_000, [read]);
  await turn(101_000, [writeNote], { fail: true });
  await turn(102_000, [["write", { path: "other.md", content: "x" }]]);
  assert.equal(state.aborted, 0);
  const c = session("commit");
  await c.turn(100_000, [read]);
  await c.turn(101_000, [writeNote]);
  await c.turn(102_000, [commitCall], { fail: true });
  assert.equal(c.state.aborted, 0);
}

// Without a note the child is ended when the context grows by a full reserve.
{
  const { state, h, turn } = session();
  await turn(100_000, [read]);
  await turn(129_999, [read]);
  assert.equal(state.aborted, 0);
  await turn(130_000, [read]);
  assert.equal(state.aborted, 1);
  assert.deepEqual(h.entries.at(-1).data, { kind: "ended", tokens: 130_000, turns: 2 });
  await turn(160_000, [read]);
  assert.equal(state.aborted, 1);
}

// Or after six turns, whatever the size; a final reply does not end it.
{
  const { state, h, turn } = session();
  await turn(100_000, [read]);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(state.aborted, 0, `after ${i} turns`);
    await turn(100_100, [read]);
  }
  assert.equal(state.aborted, 1);
  assert.equal(h.entries.at(-1).data.turns, 6);

  const f = session();
  await f.turn(100_000, [read]);
  for (let i = 0; i < 8; i += 1) {
    await f.h.turnEnd(assistant({ totalTokens: 200_000 }, "stop", [{ type: "text" }]), f.ctx);
  }
  assert.equal(f.state.aborted, 0);
}

// After firing, the other triggers stay quiet.
{
  const { h, ctx, turn } = session();
  await turn(100_000, [read]);
  await h.turnEnd(assistant({ totalTokens: 100_500 }, "length"), ctx);
  await h.turnEnd(assistant({ totalTokens: 100_500 }, "length"), ctx);
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 1, "no truncation recovery and no thrash message");
  assert.equal(h.toolCall({ toolCallId: "p", toolName: "read", input: {} }, ctx).reason.includes("FAILED"), false);
}

// After the thrash ending, the size trigger does not fire.
{
  const { h, ctx, turn } = session();
  await h.sessionCompact();
  await h.sessionCompact();
  await h.sessionCompact();
  assert.equal(h.sent.length, 1);
  await turn(150_000, [read]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.entries.length, 0);
  assert.match(h.toolCall({ toolCallId: "p", toolName: "read", input: {} }, ctx).reason, /compaction thrash/);
}

console.log("budget-valve: all assertions passed");
