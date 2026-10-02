// Ends a subagent run cleanly when it stops converging, in two independent
// ways: a reply cut off by the output limit, or three compactions in a row
// with no edit or write.
//
// A cut-off reply gets one more turn to carry on in smaller pieces; a second
// cut-off gets one final, tool-permitting notice to save partial work and
// reply FAILED:, then the run is left to pi. A compaction thrash gets a
// tool-blocking notice to stop and reply FAILED: right away, since more
// tool calls are exactly what did not converge.
//
// Install outside ~/.pi/agent/extensions. pi loads everything in that directory
// into every session, the interactive one included; this is reached through
// subagents.defaultSubagentOnlyExtensions alone.

const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;
const THRASH_COMPACTIONS = 3;

const TRUNCATION_RECOVERY =
  "Your previous turn ran out of output budget before it finished, so any " +
  "tool call it was writing was discarded. Carry on, but in smaller pieces: " +
  "keep your reasoning brief, and write any large file in sections of at most " +
  "about 150 lines, one tool call per section. A second cut-off ends the run, " +
  "so if anything you have gathered is not yet on disk, save it first.";

const OUTPUT_LIMIT_FINAL =
  "Your reply was cut off by the output limit a second time. Do not retry the same step. " +
  "Save anything not yet on disk in small writes (at most about 150 lines per call), then reply with " +
  "a message whose first line starts with `FAILED: output limit`, followed by what is incomplete and " +
  "where your partial work is.";

const THRASH =
  "This run has compacted three times without an edit or write, so it is not converging. " +
  "Stop now and do not call any more tools. Reply with a message whose first line starts with " +
  "`FAILED: compaction thrash`, then say what is incomplete and which files hold your partial work.";

const BLOCKED = "Blocked: this run is ending. Reply in text, first line starting `FAILED: compaction thrash`.";

function contextTokensOf(usage) {
  if (!usage) return 0;
  return (
    usage.totalTokens ||
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

function outputHeadroom(ctx, message) {
  const usage = ctx?.getContextUsage?.();
  const window = usage?.contextWindow ?? ctx?.model?.contextWindow;
  const tokens = usage?.tokens ?? contextTokensOf(message?.usage);
  if (!window) return Infinity;
  return window - tokens - PI_RESERVE_TOKENS;
}

export default function budgetValve(pi) {
  // Per registration: foreground children share the parent's process.
  let cutoffs = 0;
  let compactionsSinceWrite = 0;
  let ending = false;
  let blockedTurns = 0;

  const send = (customType, text, deliverAs, display) =>
    pi.sendMessage(
      { customType, content: [{ type: "text", text }], display },
      { deliverAs, triggerTurn: true },
    );

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    if (ending) {
      if (message.content?.some?.((b) => b?.type === "toolCall")) blockedTurns += 1;
      return;
    }
    if (message.stopReason !== "length") return;
    if (cutoffs === 0) {
      // A recovery turn this close to the window inherits the same dead ceiling.
      if (outputHeadroom(ctx, message) < MIN_RECOVERY_HEADROOM_TOKENS) return;
      cutoffs = 1;
      await send("budget-valve-truncated", TRUNCATION_RECOVERY, "followUp", "Budget valve: recovering a truncated turn");
    } else if (cutoffs === 1) {
      cutoffs = 2;
      await send("budget-valve-final", OUTPUT_LIMIT_FINAL, "steer", "Budget valve: ending after a second cut-off");
    }
  });

  pi.on("tool_execution_end", (event) => {
    if ((event?.toolName === "edit" || event?.toolName === "write") && !event.isError) compactionsSinceWrite = 0;
  });

  pi.on("session_compact", async () => {
    if (ending) return;
    compactionsSinceWrite += 1;
    if (compactionsSinceWrite < THRASH_COMPACTIONS) return;
    ending = true;
    await send("budget-valve-thrash", THRASH, "steer", "Budget valve: ending a compaction thrash");
  });

  pi.on("tool_call", () => (ending ? { block: true, reason: BLOCKED, terminate: blockedTurns >= 1 } : undefined));
}
