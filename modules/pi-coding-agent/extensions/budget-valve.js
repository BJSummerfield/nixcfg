// Gives a subagent one more turn when its reply is cut off by the output limit.
// pi ends the run there if the cut-off reply held no tool call, and the parent
// gets half a message. Context is left to pi: a child compacts and carries on.
//
// Install outside ~/.pi/agent/extensions. pi loads everything in that directory
// into every session, the interactive one included; this is reached through
// subagents.defaultSubagentOnlyExtensions alone.

const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;

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

function outputHeadroom(ctx, message) {
  const usage = ctx?.getContextUsage?.();
  const window = usage?.contextWindow ?? ctx?.model?.contextWindow;
  const tokens = usage?.tokens ?? contextTokensOf(message?.usage);
  if (!window) return Infinity;
  return window - tokens - PI_RESERVE_TOKENS;
}

export default function budgetValve(pi) {
  // Per registration: foreground children share the parent's process.
  let recoveryAttempted = false;

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    if (message.stopReason !== "length") return;
    if (recoveryAttempted) return;
    // A recovery turn this close to the window inherits the same dead ceiling.
    if (outputHeadroom(ctx, message) < MIN_RECOVERY_HEADROOM_TOKENS) return;
    recoveryAttempted = true;
    await pi.sendMessage(
      {
        customType: "budget-valve-truncated",
        content: [{ type: "text", text: TRUNCATION_RECOVERY }],
        display: "Budget valve: recovering a truncated turn",
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}
