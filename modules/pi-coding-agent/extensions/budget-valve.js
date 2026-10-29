// Loaded only into pi-subagents child sessions. Ends a child run cleanly
// when it stops converging, so the parent reads a report of what is left
// instead of a hung or looping run.
//
// Install outside ~/.pi/agent/extensions: pi loads everything in that
// directory into every session, the interactive one included.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_RESERVE_TOKENS = 4096;
const MIN_RECOVERY_HEADROOM_TOKENS = 2000;
const THRASH_COMPACTIONS = 3;
const HANDOFF_TURNS = 4;
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
  "Stop now and do not call any more tools except writing or editing files, for two turns. " +
  "Put a first line `FAILED: compaction thrash` at the top of the output file your task names " +
  "(write that file if you have not), with what is incomplete and which files hold your partial " +
  "work, then reply with a message whose first line is that same line.";

const THRASH_BLOCKED =
  "Blocked: only writing your output file is allowed. " +
  "Put the `FAILED: compaction thrash` line at its top, then reply with that line.";

const BLOCKED = "Blocked: this run is ending.";

const HANDOFF_BLOCKED =
  "Blocked: this run is at its context budget and is handing off. " +
  "Only writing files and git (add, commit, status, diff, log, show, rev-parse) are allowed now.";

const handoffText = (tokens) =>
  `You have reached your context budget (about ${tokens} tokens). Stop new work now. ` +
  "If you changed files in a git repository, commit them. " +
  "Then write to the output path your task names a note whose first line is " +
  "`handoff: <what is done; what is left>`, followed by the sections " +
  "`## Done`, `## Left` and `## Watch for`. Reply with that same first line. " +
  "From now on only writing files and git are allowed.";

export function readOptions(paths) {
  for (const path of paths) {
    try {
      const options = JSON.parse(readFileSync(path, "utf8"));
      if (typeof options?.handoffTokens === "number" && options.handoffTokens > 0) return { handoffTokens: options.handoffTokens };
    } catch {
      // The config is optional, so loading must still succeed without it.
    }
  }
  return undefined;
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

const hasToolCall = (message) => message.content?.some?.((b) => b?.type === "toolCall");

export default function budgetValve(pi, options = readOptions([
  join(homedir(), ".pi", "agent", "subagent-only", "budget-valve.json"),
  join(dirname(fileURLToPath(import.meta.url)), "budget-valve.json"),
])) {
  // Per registration: foreground children share the parent's process.
  let cutoffs = 0;
  let compactionsSinceWrite = 0;
  let ending = false;
  let blockedTurns = 0;
  let handingOff = false;
  let handoffTurns = 0;
  const budget = typeof options?.handoffTokens === "number" && options.handoffTokens > 0 ? options.handoffTokens : null;

  const send = (customType, text, deliverAs, display) =>
    pi.sendMessage(
      { customType, content: [{ type: "text", text }], display },
      { deliverAs, triggerTurn: true },
    );

  pi.on("turn_end", async (event, ctx) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    if (ending) {
      if (hasToolCall(message)) blockedTurns += 1;
      return;
    }
    if (handingOff && hasToolCall(message)) handoffTurns += 1;
    if (!handingOff && budget !== null && hasToolCall(message) && contextTokensOf(message.usage) >= budget) {
      handingOff = true;
      await send("budget-valve-handoff", handoffText(contextTokensOf(message.usage)), "steer", "Budget valve: handing off at the context budget");
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
    if (ending || handingOff) return;
    compactionsSinceWrite += 1;
    if (compactionsSinceWrite < THRASH_COMPACTIONS) return;
    ending = true;
    await send("budget-valve-thrash", THRASH, "steer", "Budget valve: ending a compaction thrash");
  });

  const handoffAllows = (event) => {
    if (event?.toolName === "write" || event?.toolName === "edit") return true;
    if (event?.toolName === "bash") return gitSubcommands(event.input?.command) !== null;
    return false;
  };

  pi.on("tool_call", (event) => {
    if (ending) {
      // The note gets two tool-bearing turns to save, then the run ends no
      // matter what: a child that cannot write it must not loop.
      if ((event?.toolName === "write" || event?.toolName === "edit") && blockedTurns < 2) return undefined;
      if (blockedTurns >= 2) return { block: true, reason: BLOCKED, terminate: true };
      return { block: true, reason: THRASH_BLOCKED, terminate: false };
    }
    if (!handingOff) return undefined;
    if (handoffTurns >= HANDOFF_TURNS) return { block: true, reason: HANDOFF_BLOCKED, terminate: true };
    if (handoffAllows(event)) return undefined;
    return { block: true, reason: HANDOFF_BLOCKED };
  });
}
