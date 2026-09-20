/**
 * Budget valve: stop a turn deliberately instead of letting it hit a wall.
 *
 * Two walls, both measured on this rig (llm-review/HANDOFF.md, and the NInfer
 * run of 2026-09-19):
 *
 *   1. The output limit. A turn that runs out of output budget mid-tool-call
 *      has its call degraded to plain text, which ends the agent loop with
 *      nothing actionable. Seen twice in one evening (engine logs: "output
 *      limit" followed by "tool markup returned as text"), costing ~5 minutes
 *      of GPU time for no result.
 *   2. The compaction threshold. pi auto-compacts at contextWindow minus the
 *      reserve; the compaction succeeded, and the session never resumed.
 *
 * Both are the same shape: the turn is allowed to run into something instead of
 * stopping on its own terms. This extension makes it stop on its own terms.
 *
 * Field notes, all verified against pi 0.85.1 at
 * /nix/store/...-pi-coding-agent-0.85.1/lib/node_modules/pi-monorepo:
 *
 *   - `turn_end` carries `message.stopReason` directly (extensions/types.d.ts),
 *     so truncation needs no inference from usage.
 *   - Context size is `calculateContextTokens()`
 *     (core/compaction/compaction.js:86) = `usage.totalTokens` or the sum of
 *     the four counters. NOT `usage.input`, which is per-turn.
 *   - `turn_end` handlers are awaited before the loop decides whether to stop,
 *     and `isStreaming` is still true, so `deliverAs: "followUp"` lands in the
 *     same run rather than after it.
 *   - Cancelling `session_before_compact` is a plain `if (result?.cancel)`
 *     inside a try/catch. It does not throw uncatchably or wedge the session.
 */

/**
 * Ask for a handoff here. pi clamps output to
 * contextWindow - prompt - CONTEXT_SAFETY_TOKENS, so at 64k of a 98,304 window
 * there are still ~30k of output headroom, and pi's own auto-compaction
 * threshold (contextWindow - 16,384 = 81,920) is comfortably above. The valve
 * therefore fires while the turn can still do something about it.
 */
const HANDOFF_THRESHOLD_TOKENS = 64000;

const HANDOFF_REQUEST =
  "Context budget: this session has passed 64,000 tokens and is approaching " +
  "the point where the harness would compact it, which loses the thread. " +
  "Wrap up now, in this order: FIRST write your output file with everything " +
  "you have so far, THEN reply with a short handoff - what you finished, what " +
  "remains, and the paths a successor needs. Do not start new work.";

const TRUNCATION_RECOVERY =
  "Your previous turn ran out of output budget before it finished, so any " +
  "tool call it was writing was discarded. Do not retry that work now. " +
  "FIRST write your output file with the results you already have, THEN reply " +
  "in one or two sentences stating that the attempt was cut off and what was " +
  "incomplete.";

/** `calculateContextTokens` (core/compaction/compaction.js:86), reimplemented. */
function contextTokensOf(usage) {
  if (!usage) return 0;
  return (
    usage.totalTokens ||
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

export default function budgetValve(pi) {
  // Per-registration, not module-level: one extension instance per session, and
  // a module-level flag would leak between the sessions sharing a process (for
  // foreground subagents, the child runs inside the parent's process).
  let handoffRequested = false;
  let truncationRecoveryAttempted = false;

  pi.on("turn_end", async (event) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;

    // Wall 1: the turn was cut off. Recover once - a second attempt against a
    // context that is still too full would just truncate again.
    if (message.stopReason === "length") {
      if (truncationRecoveryAttempted) return;
      truncationRecoveryAttempted = true;
      await pi.sendMessage(
        {
          customType: "budget-valve-truncated",
          content: [{ type: "text", text: TRUNCATION_RECOVERY }],
          display: "Budget valve: recovering a truncated turn",
        },
        // followUp runs after the agent would otherwise stop, which is exactly
        // the defect: a length stop with no tool calls ends the run.
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }

    // Wall 2: the context is filling. Ask for a handoff on the next turn rather
    // than interrupting this one, which may be mid-tool-call.
    if (handoffRequested) return;
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

  pi.on("session_before_compact", (event) => {
    // Backstop only, and only for subagents. A compaction inside a child loses
    // the run's thread (measured 2026-09-20: compaction succeeded, the session
    // never took another turn), so a child is better off ending with whatever
    // it has - pi-subagents reads its last message as the result either way.
    //
    // The interactive session is left alone deliberately: cancelling there
    // would trade a recoverable compaction for a context overflow, and the
    // valve above has already asked for a wrap-up 17k tokens earlier.
    if (!process.env.PI_SUBAGENT_CHILD) return;

    // "overflow" means pi has already stripped the failed turn and intends to
    // compact-and-retry. Cancelling that is lossier than letting it run, so
    // only the threshold path is intercepted.
    if (event?.reason !== "threshold") return;

    return { cancel: true };
  });
}
