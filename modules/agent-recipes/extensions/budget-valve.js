// The runner can only spawn, watch and kill a child process, so anything
// that has to reach a live session runs here. A reply cut off by the output
// budget would end the run unless the session is given another turn, and
// only the session itself can trigger that turn. A session that keeps
// compacting without progress can only be stopped from the outside by
// killing it, so the stop has to come from inside. A resumed handoff turn
// is confined by refusing tool calls, which the runner cannot do from
// outside the process, and the runner ends that turn, so a refusal is never
// terminal.
//
// Install outside ~/.pi/agent/extensions. pi loads everything in that directory
// into every session, the interactive one included; recipe-runner children
// load it through roles.json.

import path from "node:path";

const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;
const THRASH_COMPACTIONS = 3;
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

  const guarded = env.RECIPE_HANDOFF_GUARD === "1";
  const action = HANDOFF_ACTIONS.includes(env.RECIPE_HANDOFF_ACTION) ? env.RECIPE_HANDOFF_ACTION : "stop";
  const output = env.RECIPE_OUTPUT ? path.resolve(env.RECIPE_OUTPUT) : null;

  const send = (customType, text, deliverAs, display) =>
    pi.sendMessage(
      { customType, content: [{ type: "text", text }], display },
      { deliverAs, triggerTurn: true },
    );

  const hasToolCall = (message) => message.content?.some?.((b) => b?.type === "toolCall");

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    if (ending) {
      if (hasToolCall(message)) blockedTurns += 1;
      return;
    }
    if (guarded || message.stopReason !== "length") return;
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
    if (ending || guarded) return;
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
    if (!guarded) return undefined;
    if (handoffKind(event, ctx)) return undefined;
    return { block: true, reason: blockedText(action, output) };
  });
}
