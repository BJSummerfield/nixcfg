// Stubs old tool output in the outgoing request so a session compacts later; the session file is untouched.
//
// Install inside ~/.pi/agent/extensions: pi loads everything there into
// every session, the interactive one and every child alike.

const PRUNE_AT = 0.58;
const PRUNE_TO = 0.38;
const PROTECT_RECENT = 16_384;
const MIN_STUB = 256;
const EXEMPT = new Set(["subagent", "bg_wait", "subagent_supervisor"]);
const ESTIMATED_IMAGE_CHARS = 4800;

const STUB = (n) => `[output dropped to save context: ~${n} tokens. Re-run the tool if you need it.]`;

function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text") chars += block.text.length;
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

function systemChars(message) {
  let chars = contentChars(message.content);
  for (const text of Object.values(message.sections ?? {})) {
    if (typeof text === "string") chars += text.length;
  }
  if (message.toolsAdded?.length) chars += JSON.stringify(message.toolsAdded).length;
  if (message.toolsRemoved?.length) chars += JSON.stringify(message.toolsRemoved).length;
  return chars;
}

function est(message) {
  if (!message) return 0;
  switch (message.role) {
    case "user":
    case "toolResult":
    case "custom":
      return Math.ceil(contentChars(message.content) / 4);
    case "system":
      return Math.ceil(systemChars(message) / 4);
    case "compactionSummary":
    case "branchSummary":
      return Math.ceil((message.summary?.length ?? 0) / 4);
    case "bashExecution":
      return Math.ceil(((message.command?.length ?? 0) + (message.output?.length ?? 0)) / 4);
    case "assistant": {
      let chars = 0;
      for (const block of message.content ?? []) {
        if (block?.type === "text") chars += block.text.length;
        else if (block?.type === "thinking") chars += block.thinking.length;
        else if (block?.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

function indexWhereSuffixExceeds(sizes, budget) {
  let sum = 0;
  for (let i = sizes.length - 1; i >= 0; i--) {
    if (sum >= budget) return i + 1;
    sum += sizes[i];
  }
  return 0;
}

export default function pruneToolOutput(pi) {
  const stubbed = new Set();

  pi.on("context", (event, ctx) => {
    const window = ctx?.getContextUsage?.()?.contextWindow ?? ctx?.model?.contextWindow;
    const msgs = event?.messages;
    if (!window || !Array.isArray(msgs)) return undefined;

    const sizes = msgs.map(est);
    let total = sizes.reduce((a, b) => a + b, 0);
    const out = msgs.slice();

    const stubOf = (i) => {
      const m = msgs[i];
      const n = sizes[i];
      return { ...m, content: [{ type: "text", text: STUB(n) }] };
    };

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role === "toolResult" && stubbed.has(m.toolCallId)) {
        const replacement = stubOf(i);
        out[i] = replacement;
        total -= sizes[i] - est(replacement);
      }
    }

    if (total > PRUNE_AT * window) {
      const protectFrom = indexWhereSuffixExceeds(sizes, PROTECT_RECENT);
      for (let i = 0; i < protectFrom && total > PRUNE_TO * window; i++) {
        const m = msgs[i];
        if (m?.role !== "toolResult" || stubbed.has(m.toolCallId) || EXEMPT.has(m.toolName) || sizes[i] <= MIN_STUB) {
          continue;
        }
        stubbed.add(m.toolCallId);
        const replacement = stubOf(i);
        out[i] = replacement;
        total -= sizes[i] - est(replacement);
      }
    }

    return out.some((m, i) => m !== msgs[i]) ? { messages: out } : undefined;
  });
}
