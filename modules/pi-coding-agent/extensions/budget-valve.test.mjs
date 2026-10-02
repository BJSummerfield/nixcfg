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

function harness() {
  const handlers = {};
  const sent = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    sendMessage: async (message, options) => {
      sent.push({ message, options });
    },
  };
  budgetValve(pi);
  return {
    sent,
    handlers,
    turnEnd: (message, ctx) => handlers.turn_end({ type: "turn_end", message }, ctx),
    toolExecutionEnd: (event) => handlers.tool_execution_end({ type: "tool_execution_end", ...event }),
    sessionCompact: () => handlers.session_compact({ type: "session_compact" }),
    toolCall: () => handlers.tool_call({ type: "tool_call" }),
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

// Context size is pi's business: no turn is interrupted for being large, and
// nothing is ever aborted.
{
  const h = harness();
  let aborted = 0;
  const ctx = { abort: () => (aborted += 1) };
  await h.turnEnd(assistant({ totalTokens: 70_000 }), ctx);
  await h.turnEnd(assistant({ totalTokens: 90_000 }, "toolUse"), ctx);
  await h.turnEnd(assistant({ totalTokens: 95_000 }, "toolUse"), ctx);
  assert.equal(h.sent.length, 0, "no handoff request at any size");
  assert.equal(aborted, 0, "no abort at any size");
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

// R1: a "length" stop that pi would also treat as recoverable overflow
// (output short of the model's unclamped maxTokens, near a full window) is
// already covered by the state-0 headroom gate above: a queued valve message
// drains before agent_end, so whichever of the two acts first simply
// pre-empts the other, and there is no double handling to guard against. A
// real-shaped ctx (contextWindow and tokens close to full, as #220's clamp
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

console.log("budget-valve: all assertions passed");
