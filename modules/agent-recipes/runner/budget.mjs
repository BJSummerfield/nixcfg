// The budget handoff lives here rather than in each harness so that every
// harness fires at the same size and ends the handoff turn the same way.

import path from "node:path";

export const HANDOFF_TIMEOUT_MS = 600_000;
export const END_TURNS = 6;

// Repeated from harness/claude.mjs rather than imported: this module must stay
// pure, and a commit has to count here exactly as it counts there.
const GIT_COMMIT = /\bgit\b[^\n;&|]*\bcommit\b/;

const positiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

export function budgetTrigger(budget) {
  const tokens = budget?.tokens;
  const enabled = positiveNumber(tokens);
  let fired = false;
  let stopped = false;
  return {
    observe: (turn) => {
      if (stopped || fired || !enabled) return null;
      const calls = turn?.calls;
      if (!Array.isArray(calls) || calls.length === 0) return null;
      const context = turn?.context;
      if (!positiveNumber(context) || context < tokens) return null;
      fired = true;
      return { tokens: context };
    },
    stop: () => {
      stopped = true;
    },
  };
}

export function callKind(call, o) {
  const tool = call?.tool;
  if (tool === "write" || tool === "edit") {
    if (typeof o?.output !== "string" || typeof call?.path !== "string") return null;
    return path.resolve(call.path) === path.resolve(o.output) ? "note" : null;
  }
  if (tool === "bash" && o?.action === "commit" && typeof call?.command === "string") {
    return GIT_COMMIT.test(call.command) ? "commit" : null;
  }
  return null;
}

export function handoffEnd(budget, o) {
  const needCommit = budget?.action === "commit";
  const reserve = budget?.reserve;
  const firedTokens = o?.firedTokens;
  let noteDone = false;
  let commitDone = false;
  let ended = false;
  let turns = 0;
  return {
    observe: (turn) => {
      if (ended) return false;
      const calls = Array.isArray(turn?.calls) ? turn.calls : [];
      const results = Array.isArray(turn?.results) ? turn.results : [];
      for (const call of calls) {
        if (call?.id == null) continue;
        const kind = callKind(call, { output: o?.output, action: budget?.action });
        if (!kind) continue;
        const result = results.find((r) => r?.id === call.id);
        if (!result || result.isError) continue;
        if (kind === "note") noteDone = true;
        else commitDone = true;
      }
      if (calls.length === 0) return false;
      turns += 1;
      const context = turn?.context;
      const bySize =
        positiveNumber(reserve) && positiveNumber(firedTokens) && positiveNumber(context) && context >= firedTokens + reserve;
      const done = noteDone && (!needCommit || commitDone);
      if (!done && !bySize && turns < END_TURNS) return false;
      ended = true;
      return true;
    },
  };
}

export function valveRecord(budget, firedTokens, ended) {
  return { fired: true, tokens: firedTokens, budget: budget.tokens, action: budget.action, ended };
}
