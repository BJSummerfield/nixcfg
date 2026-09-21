/**
 * Behaviour tests for the budget valve. Run by `nix flake check`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses; they cannot prove pi's own semantics (that `followUp`
 * lands in the same run), which were verified by reading the installed 0.85.1
 * source instead.
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
  };
}

const assistant = (usage, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
});

// A truncated turn is recovered with a followUp, once.
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  await h.turnEnd(assistant({ totalTokens: 30_000 }, "length"));
  assert.equal(h.sent.length, 1, "recovery is one-shot");
  assert.equal(h.sent[0].message.customType, "budget-valve-truncated");
  assert.equal(h.sent[0].options.deliverAs, "followUp");
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.match(h.sent[0].message.content[0].text, /FIRST write your output file/);
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

// A child compacts like any other session: the valve does not listen for it.
{
  const h = harness();
  assert.equal(h.handlers.session_before_compact, undefined);
}

// No recovery when the window is nearly full: the recovery turn would inherit the
// same dead ceiling. The run is left to pi, not aborted.
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

// A skipped recovery does not use up the one attempt.
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

console.log("budget-valve: all assertions passed");
