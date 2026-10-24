// Ends a recipe-runner child cleanly when it stops converging or outgrows its
// context budget, in three independent ways: a reply cut off by the output
// limit, three compactions in a row with no edit or write, or a context at the
// role's budget.
//
// A cut-off reply gets one more turn to carry on in smaller pieces; a second
// cut-off gets one final, tool-permitting notice to save partial work and
// reply FAILED:, then the run is left to pi. A compaction thrash gets a
// tool-blocking notice to stop and reply FAILED: right away, since more
// tool calls are exactly what did not converge.
//
// A context at the budget (RECIPE_BUDGET_TOKENS) gets one steer asking for a
// handoff: write the note (and, for an implementer, commit first) and nothing
// else. Only that is allowed from then on. A child that keeps going is ended,
// but never before its note and commit are done: it is ended once they are,
// or after a further reserve of tokens, or after a few more turns.
//
// Install outside ~/.pi/agent/extensions. pi loads everything in that directory
// into every session, the interactive one included; recipe-runner children
// load it through roles.json.

import path from "node:path";

const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;
const THRASH_COMPACTIONS = 3;
const HANDOFF_TURNS = 4;
const END_TURNS = 6;
const HANDOFF_ACTIONS = ["commit", "unread", "stop"];
const ALLOWED_GIT = new Set(["add", "commit", "status", "diff", "log", "show", "rev-parse"]);

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
  "where your partial work is. If you already wrote to the output path your task names, first put that " +
  "same `FAILED: output limit` line at the top of that file.";

const THRASH =
  "This run has compacted three times without an edit or write, so it is not converging. " +
  "Stop now and do not call any more tools. Reply with a message whose first line starts with " +
  "`FAILED: compaction thrash`, then say what is incomplete and which files hold your partial work.";

const BLOCKED = "Blocked: this run is ending. Reply in text, first line starting `FAILED: compaction thrash`.";

function handoffText(action, output, budget) {
  const where = output ? `the file ${output}` : "your reply";
  const first =
    "The first line, in the note and in your reply, is `handoff: <what is done; what is left>`.";
  const opening =
    `Your context has reached its budget of ${budget} tokens. Stop new work now: read nothing more, ` +
    "start nothing new. ";
  if (action === "commit") {
    return (
      opening +
      "Commit everything you changed with git first, then write the note to " +
      `${where} with the sections Done, Left and Watch for. ${first} ` +
      "Only git and writing that file are allowed from now on; anything else is refused."
    );
  }
  if (action === "unread") {
    return (
      opening +
      `Write the partial result you have so far to ${where}, in the format your task asks for, ` +
      "then add one line `unread: <path>` for each input you have not read in full. " +
      `${first} Repeat the unread lines in your reply. ` +
      "Only writing that file is allowed from now on; anything else is refused."
    );
  }
  return (
    opening +
    `Write what you have found so far to ${where}, in the format your task asks for. ${first} ` +
    "Only writing that file is allowed from now on; anything else is refused."
  );
}

function blockedText(action, output) {
  const allowed =
    action === "commit"
      ? `git (add, commit, status, diff, log, show, rev-parse) and writing ${output || "the output file"}`
      : `writing ${output || "the output file"}`;
  return `Blocked: this run is at its context budget and is handing off. Only ${allowed} is allowed now.`;
}

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

function contextTokens(ctx, message) {
  return ctx?.getContextUsage?.()?.tokens ?? contextTokensOf(message?.usage);
}

// Splits a shell command on `&&`, `;` and newlines outside quotes into token
// lists. Returns null for anything that could run something else: pipes,
// redirects, background jobs, subshells and command substitution.
function splitCommand(command) {
  const segments = [];
  let tokens = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "`" || (c === "$" && command[i + 1] === "(")) return null;
      else if (c === "\\" && i + 1 < command.length) word += command[(i += 1)];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[(i += 1)];
      inWord = true;
    } else if (c === "&" && command[i + 1] === "&") {
      i += 1;
      endSegment();
    } else if (c === ";" || c === "\n") {
      endSegment();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if ("|&<>`()".includes(c) || (c === "$" && command[i + 1] === "(")) {
      return null;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return null;
  endSegment();
  return segments;
}

// The git subcommands of a command made only of allowed git calls (also
// `git -C <dir> ...`) and `cd <dir>`, or null when it is anything else.
function gitSubcommands(command) {
  const segments = typeof command === "string" ? splitCommand(command) : null;
  if (!segments) return null;
  const subs = [];
  for (const tokens of segments) {
    if (tokens[0] === "cd" && tokens.length === 2) continue;
    if (tokens[0] !== "git") return null;
    const at = tokens[1] === "-C" ? 3 : 1;
    if (at === 3 && tokens.length < 4) return null;
    const sub = tokens[at];
    if (!ALLOWED_GIT.has(sub)) return null;
    subs.push(sub);
  }
  return subs.length ? subs : null;
}

export default function budgetValve(pi, env = process.env) {
  // Per registration: foreground children share the parent's process.
  let cutoffs = 0;
  let compactionsSinceWrite = 0;
  let ending = false;
  let blockedTurns = 0;

  const budget = Number(env.RECIPE_BUDGET_TOKENS);
  const sizeTrigger = Number.isFinite(budget) && budget > 0;
  const reserve = Number(env.RECIPE_BUDGET_RESERVE);
  const hasReserve = Number.isFinite(reserve) && reserve > 0;
  const action = HANDOFF_ACTIONS.includes(env.RECIPE_HANDOFF_ACTION) ? env.RECIPE_HANDOFF_ACTION : "stop";
  const output = env.RECIPE_OUTPUT ? path.resolve(env.RECIPE_OUTPUT) : null;
  const role = env.RECIPE_ROLE ?? null;
  let fired = false;
  let firedTokens = 0;
  let handoffEnded = false;
  let turnsSinceFire = 0;
  let noteDone = false;
  let commitDone = false;
  // Allowed post-fire tool calls that count toward finishing the handoff.
  const handoffCalls = new Map();

  const send = (customType, text, deliverAs, display) =>
    pi.sendMessage(
      { customType, content: [{ type: "text", text }], display },
      { deliverAs, triggerTurn: true },
    );

  const hasToolCall = (message) => message.content?.some?.((b) => b?.type === "toolCall");

  const handoffCheck = (event, ctx, message) => {
    turnsSinceFire += 1;
    if (handoffEnded) return;
    for (const result of event?.toolResults ?? []) {
      const kind = handoffCalls.get(result?.toolCallId);
      if (!kind || result.isError) continue;
      if (kind === "note") noteDone = true;
      else commitDone = true;
    }
    if (!hasToolCall(message)) return;
    const tokens = contextTokens(ctx, message);
    const done = noteDone && (action !== "commit" || commitDone);
    if (!done && !(hasReserve && tokens >= firedTokens + reserve) && turnsSinceFire < END_TURNS) return;
    handoffEnded = true;
    pi.appendEntry("budget-valve", { kind: "ended", tokens, turns: turnsSinceFire });
    ctx.abort();
  };

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    if (ending) {
      if (hasToolCall(message)) blockedTurns += 1;
      return;
    }
    if (fired) {
      handoffCheck(event, ctx, message);
      return;
    }
    if (sizeTrigger && (message.stopReason === "toolUse" || hasToolCall(message))) {
      const tokens = contextTokens(ctx, message);
      if (tokens >= budget) {
        fired = true;
        firedTokens = tokens;
        pi.appendEntry("budget-valve", { kind: "handoff", role, action, budget, reserve, tokens });
        await send("budget-valve-handoff", handoffText(action, output, budget), "steer", "Budget valve: handing off at the context budget");
        return;
      }
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
    if (ending || fired) return;
    compactionsSinceWrite += 1;
    if (compactionsSinceWrite < THRASH_COMPACTIONS) return;
    ending = true;
    await send("budget-valve-thrash", THRASH, "steer", "Budget valve: ending a compaction thrash");
  });

  const handoffKind = (event, ctx) => {
    const input = event?.input;
    if (event?.toolName === "write" || event?.toolName === "edit") {
      if (!output || typeof input?.path !== "string") return null;
      return path.resolve(ctx?.cwd ?? process.cwd(), input.path) === output ? "note" : null;
    }
    if (event?.toolName === "bash" && action === "commit") {
      const subs = gitSubcommands(input?.command);
      if (!subs) return null;
      return subs.includes("commit") ? "commit" : "git";
    }
    return null;
  };

  pi.on("tool_call", (event, ctx) => {
    if (ending) return { block: true, reason: BLOCKED, terminate: blockedTurns >= 1 };
    if (!fired) return undefined;
    const kind = handoffKind(event, ctx);
    if (kind) {
      if (kind !== "git" && event?.toolCallId !== undefined) handoffCalls.set(event.toolCallId, kind);
      return undefined;
    }
    return {
      block: true,
      reason: blockedText(action, output),
      terminate: handoffEnded || turnsSinceFire >= HANDOFF_TURNS,
    };
  });
}
