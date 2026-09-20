/**
 * Behaviour tests for the budget valve. Run by `nix flake check`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses; they cannot prove pi's own semantics (that `followUp`
 * lands in the same run, that a cancelled compaction is caught), which were
 * verified by reading the installed 0.85.1 source instead.
 */
import assert from "node:assert/strict";
import budgetValve from "./budget-valve.js";

function harness({ child = false } = {}) {
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
  const previousChildEnv = process.env.PI_SUBAGENT_CHILD;
  if (child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  budgetValve(pi);
  return {
    sent,
    turnEnd: (message) => handlers.turn_end({ type: "turn_end", message }),
    beforeCompact: (event) => handlers.session_before_compact(event),
    restore: () => {
      if (previousChildEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChildEnv;
    },
  };
}

const assistant = (usage, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage },
});

// A turn well under the threshold is left alone.
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 40_000 }));
  assert.equal(h.sent.length, 0, "quiet below the threshold");
  h.restore();
}

// Crossing the threshold asks for a handoff, once, on the next turn.
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 64_000 }));
  await h.turnEnd(assistant({ totalTokens: 70_000 }));
  assert.equal(h.sent.length, 1, "handoff is one-shot");
  assert.equal(h.sent[0].message.customType, "budget-valve-handoff");
  assert.equal(h.sent[0].options.deliverAs, "nextTurn");
  assert.match(h.sent[0].message.content[0].text, /FIRST write your output file/);
  h.restore();
}

// Context size follows calculateContextTokens: the sum, when totalTokens is absent.
{
  const h = harness();
  await h.turnEnd(assistant({ input: 60_000, output: 3_000, cacheRead: 1_000, cacheWrite: 500 }));
  assert.equal(h.sent.length, 1, "summed counters cross the threshold");
  h.restore();
}

// usage.input alone must not trigger it - that field is per-turn, not context.
{
  const h = harness();
  await h.turnEnd(assistant({ input: 5_000, output: 200, totalTokens: 20_000 }));
  assert.equal(h.sent.length, 0, "totalTokens wins over a small input");
  h.restore();
}

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
  h.restore();
}

// Truncation wins over the handoff branch: a cut-off turn near the threshold
// needs recovering, not a wrap-up request it cannot act on.
{
  const h = harness();
  await h.turnEnd(assistant({ totalTokens: 90_000 }, "length"));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "budget-valve-truncated");
  h.restore();
}

// Non-assistant turn_end payloads are ignored.
{
  const h = harness();
  await h.turnEnd({ role: "user", usage: { totalTokens: 90_000 } });
  await h.turnEnd(undefined);
  assert.equal(h.sent.length, 0);
  h.restore();
}

// Compaction: cancelled only for a subagent child, and only on the threshold path.
{
  const h = harness({ child: true });
  assert.deepEqual(h.beforeCompact({ reason: "threshold" }), { cancel: true });
  assert.equal(h.beforeCompact({ reason: "overflow", willRetry: true }), undefined);
  assert.equal(h.beforeCompact({ reason: "manual" }), undefined);
  h.restore();
}

// The interactive session compacts normally.
{
  const h = harness({ child: false });
  assert.equal(h.beforeCompact({ reason: "threshold" }), undefined);
  h.restore();
}

console.log("budget-valve: all assertions passed");
