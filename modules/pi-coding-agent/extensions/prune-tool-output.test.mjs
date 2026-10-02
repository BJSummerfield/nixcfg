/**
 * Behaviour tests for tool-output pruning. Run by `nix flake check`.
 *
 * These exercise the extension against a stub of the parts of pi's
 * ExtensionAPI it uses (the `context` event payload shape and
 * ctx.getContextUsage()), verified by reading the installed 0.86.1 source.
 */
import assert from "node:assert/strict";
import pruneToolOutput from "./prune-tool-output.js";

const WINDOW = 98_304;

function harness() {
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  pruneToolOutput(pi);
  return {
    context: (messages, ctx = { getContextUsage: () => ({ contextWindow: WINDOW }) }) =>
      handlers.context({ type: "context", messages }, ctx),
  };
}

const text = (tokens) => "x".repeat(tokens * 4);

const toolResult = (id, tokens, { toolName = "read", isError = false, content } = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  isError,
  timestamp: 0,
  content: content ?? [{ type: "text", text: text(tokens) }],
});

const systemMsg = (tokens) => ({ role: "system", content: text(tokens), timestamp: 0 });

const summaryMsg = (role, tokens) => ({ role, summary: text(tokens), fromId: "x", tokensBefore: 0, timestamp: 0 });

const assistantToolCall = (id, name = "read") => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "reasoning about the next step" },
    { type: "toolCall", toolCallId: id, name, arguments: { path: "/x" } },
  ],
});

// 1. Under PRUNE_AT: returns undefined (no change, no cache break).
{
  const h = harness();
  const messages = [assistantToolCall("a1"), toolResult("a1", 1000)];
  assert.equal(h.context(messages), undefined);
}

// 2. Over PRUNE_AT: oldest large results are stubbed until <= PRUNE_TO;
// toolCallId/toolName/isError are kept; the assistant toolCall and thinking
// blocks are byte-identical.
{
  const h = harness();
  const messages = [
    assistantToolCall("t1"),
    toolResult("t1", 15_000),
    assistantToolCall("t2"),
    toolResult("t2", 15_000),
    assistantToolCall("t3"),
    toolResult("t3", 15_000),
    assistantToolCall("t4"),
    toolResult("t4", 15_000),
  ];
  const result = h.context(messages);
  assert.ok(result, "a 60k-token prompt is over the 57,016-token PRUNE_AT line");
  const out = result.messages;

  for (const i of [0, 2, 4, 6]) assert.deepEqual(out[i], messages[i], "assistant messages are byte-identical");

  const t1 = out[1];
  assert.equal(t1.toolCallId, "t1");
  assert.equal(t1.toolName, "read");
  assert.equal(t1.isError, false);
  assert.match(t1.content[0].text, /output dropped to save context/);

  const t4 = out[7];
  assert.deepEqual(t4, messages[7], "the newest result is untouched");

  const total = out
    .filter((m) => m.role === "toolResult")
    .reduce((sum, m) => sum + Math.ceil(m.content[0].text.length / 4), 0);
  assert.ok(total <= 0.38 * WINDOW, `pruned total ${total} should be at or under PRUNE_TO`);
}

// 3. Results in the last PROTECT_RECENT tokens, results <= MIN_STUB, and
// subagent/bg_wait/subagent_supervisor results are never stubbed.
{
  const h = harness();
  const messages = [
    toolResult("old", 40_000),
    toolResult("tiny", 200),
    toolResult("child", 40_000, { toolName: "subagent" }),
    toolResult("waited", 10_000, { toolName: "bg_wait" }),
    toolResult("supervised", 10_000, { toolName: "subagent_supervisor" }),
    toolResult("recent", 10_000),
  ];
  const result = h.context(messages);
  assert.ok(result);
  const out = result.messages;
  for (const id of ["tiny", "child", "waited", "supervised", "recent"]) {
    const i = messages.findIndex((m) => m.toolCallId === id);
    assert.deepEqual(out[i], messages[i], `${id} must never be stubbed`);
  }
  assert.match(out[0].content[0].text, /output dropped to save context/, "the old large result is the only candidate");
}

// 4. Stability: after a step, a second call with two more small messages
// appended (still under PRUNE_AT after stubs) produces a byte-identical
// prefix and does not grow `stubbed`.
{
  const h = harness();
  const messages = [toolResult("s1", 40_000), toolResult("s2", 40_000), toolResult("s3", 1_000)];
  const first = h.context(messages);
  assert.ok(first);
  const prefix = first.messages;

  const grown = [...messages, toolResult("s4", 500), toolResult("s5", 500)];
  const second = h.context(grown);
  assert.ok(second, "appending still returns a result because s1/s2 remain stubbed");
  for (let i = 0; i < prefix.length; i++) assert.deepEqual(second.messages[i], prefix[i]);
  assert.deepEqual(second.messages[3], grown[3]);
  assert.deepEqual(second.messages[4], grown[4]);
}

// 5. A later crossing adds a second step and leaves the first step's stubs
// unchanged; what ages out of PROTECT_RECENT as new growth lands behind it
// (not the newest growth itself) is what gets stubbed next.
{
  const h = harness();
  const messages = [toolResult("v1", 60_000), toolResult("v2", 60_000), toolResult("recent", 17_000)];
  const first = h.context(messages);
  assert.ok(first, "137k tokens is over PRUNE_AT");
  assert.deepEqual(first.messages[2], messages[2], "the newest result is still protected");

  const grown = [...messages, toolResult("v3", 60_000), toolResult("v4", 1_000)];
  const second = h.context(grown);
  assert.ok(second);
  assert.deepEqual(second.messages[0], first.messages[0], "v1's stub is unchanged");
  assert.deepEqual(second.messages[1], first.messages[1], "v2's stub is unchanged");
  assert.match(
    second.messages[2].content[0].text,
    /output dropped to save context/,
    "'recent' aged out of PROTECT_RECENT once v3/v4 landed behind it",
  );
  assert.deepEqual(second.messages[3], grown[3], "v3, the new newest result, is protected");
  assert.deepEqual(second.messages[4], grown[4], "v4, the new newest result, is protected");
}

// 6. An image inside an old large result is replaced (no image block remains
// in the stubbed messages).
{
  const h = harness();
  const bigImageContent = [
    { type: "text", text: text(20_000) },
    { type: "image", data: "base64...", mimeType: "image/png" },
  ];
  const messages = [
    toolResult("img", 20_000, { content: bigImageContent }),
    toolResult("filler", 40_000),
  ];
  const result = h.context(messages);
  assert.ok(result);
  const stubbedImg = result.messages[0];
  assert.ok(!stubbedImg.content.some((b) => b.type === "image"));
}

// 7. The input array and its messages are not mutated.
{
  const h = harness();
  const original = toolResult("keep-me", 40_000);
  const messages = [original, toolResult("other", 40_000)];
  const snapshotLength = messages.length;
  h.context(messages);
  assert.equal(messages.length, snapshotLength);
  assert.equal(messages[0], original);
  assert.equal(original.content[0].text.length, 40_000 * 4);
}

// 8. No window (ctx without model or usage) -> undefined.
{
  const h = harness();
  const messages = [toolResult("a", 40_000), toolResult("b", 40_000)];
  assert.equal(h.context(messages, {}), undefined);
}

// 9. B-1: est() counts the system message (prompt text plus tool
// definitions), not just toolResult content, so PRUNE_AT reflects the real
// prompt size instead of landing much later. Measured system messages run
// about 6.5k tokens in children and 13.9k in the orchestrator.
{
  const h = harness();
  const toolResults = [toolResult("sys-t1", 15_000), toolResult("sys-t2", 15_000), toolResult("sys-t3", 15_000)];
  const h2 = harness();
  const withoutSystem = h2.context(toolResults);
  assert.equal(withoutSystem, undefined, "45k of toolResult alone stays under PRUNE_AT");

  const messages = [systemMsg(14_000), ...toolResults];
  const result = h.context(messages);
  assert.ok(result, "the same 45k plus a 14k system message crosses PRUNE_AT (57,016)");
  assert.deepEqual(result.messages[0], messages[0], "the system message itself is never stubbed");
  assert.match(result.messages[1].content[0].text, /output dropped to save context/, "the oldest result is pruned");
}

// 10. compactionSummary/branchSummary messages are estimated from their
// `summary` text, not treated as zero-cost.
{
  const h = harness();
  const toolResults = [
    toolResult("post-t1", 15_000),
    toolResult("post-t2", 15_000),
    toolResult("post-t3", 15_000),
  ];
  const messages = [summaryMsg("compactionSummary", 20_000), ...toolResults];
  const result = h.context(messages);
  assert.ok(result, "a 20k compactionSummary plus 45k of toolResult crosses PRUNE_AT");
  assert.deepEqual(result.messages[0], messages[0], "the summary message itself is never stubbed");
}

console.log("prune-tool-output: all assertions passed");
