// Ends a turn before it hits the output limit or the compaction threshold.
// Child sessions are ended outright: a compaction inside one loses the run.

const HANDOFF_THRESHOLD_TOKENS = 64000;
const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;
const HANDOFF_GRACE_TURNS = 2;

const HANDOFF_REQUEST =
  "Context budget: this session has passed 64,000 tokens and is approaching " +
  "the point where the harness would compact it, which loses the thread. " +
  "Wrap up now, in this order: FIRST write your output file with everything " +
  "you have so far, THEN reply with a short handoff - what you finished, what " +
  "remains, and the paths a successor needs. Do not start new work. The run " +
  "ends after your next two turns whether or not you have replied.";

const TRUNCATION_RECOVERY =
  "Your previous turn ran out of output budget before it finished, so any " +
  "tool call it was writing was discarded. Do not retry that work now. " +
  "FIRST write your output file with the results you already have, THEN reply " +
  "in one or two sentences stating that the attempt was cut off and what was " +
  "incomplete.";

function contextTokensOf(usage) {
  if (!usage) return 0;
  return (
    usage.totalTokens ||
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

// Registration is subagents.defaultSubagentOnlyExtensions, so every session this
// loads into is already a child. The two markers this used to test for both miss
// foreground children: parentSession is set only on forks, and PI_SUBAGENT_CHILD
// only by the background runner.
function isChildSession() {
  return true;
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
  let handoffRequested = false;
  let turnsSinceHandoff = 0;
  let truncationRecoveryAttempted = false;

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const child = isChildSession(ctx);

    if (message.stopReason === "length") {
      if (outputHeadroom(ctx, message) < MIN_RECOVERY_HEADROOM_TOKENS) {
        if (child) ctx?.abort?.();
        return;
      }
      if (truncationRecoveryAttempted) return;
      truncationRecoveryAttempted = true;
      await pi.sendMessage(
        {
          customType: "budget-valve-truncated",
          content: [{ type: "text", text: TRUNCATION_RECOVERY }],
          display: "Budget valve: recovering a truncated turn",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }

    if (handoffRequested) {
      turnsSinceHandoff += 1;
      if (child && turnsSinceHandoff >= HANDOFF_GRACE_TURNS && message.stopReason === "toolUse") {
        ctx?.abort?.();
      }
      return;
    }

    if (contextTokensOf(message.usage) < HANDOFF_THRESHOLD_TOKENS) return;
    handoffRequested = true;
    await pi.sendMessage(
      {
        customType: "budget-valve-handoff",
        content: [{ type: "text", text: HANDOFF_REQUEST }],
        display: "Budget valve: asking for a handoff before compaction",
      },
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (!isChildSession(ctx)) return;
    // "overflow" is pi's compact-and-retry after a failed turn; only the
    // threshold path is intercepted.
    if (event?.reason !== "threshold") return;
    ctx?.abort?.();
    return { cancel: true };
  });
}
