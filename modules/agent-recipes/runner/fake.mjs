/**
 * Test helpers: run a graph against scripted runs, either directly or through
 * the real port with an in-process harness.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPort } from "./port.mjs";

export function portOf(runs, emit) {
  return {
    runMany: (items) => runs.all(items),
    runOne: (item) => runs.all([item]).then((results) => results[0]),
    emit: emit ?? (() => {}),
  };
}

export function fakeDeps(runs) {
  const roles = new Map();
  const harness = {
    async start(spec) {
      roles.set(spec.runId, spec.roleName);
      const [result] = await runs.all([spec.item]);
      return {
        status: result?.ok ? "done" : "failed",
        exitCode: result?.ok ? 0 : 1,
        signal: null,
        stopReason: result?.ok ? "stop" : "error",
        finalText: result?.finalText ?? "",
        error: result?.ok ? undefined : (result?.error ?? "failed"),
        structuredOutput: result?.structuredOutput,
        usage: { prompt: 0, cached: 0, output: 0, peakContext: 0, turns: 0, compactions: 0 },
        sessionFile: null,
        ms: 0,
      };
    },
  };
  const runGate = async (_gate, { outcome }) => ({
    ran: true,
    exit: 0,
    timedOut: false,
    ms: 0,
    tail: "",
    value: outcome?.structuredOutput,
    problem: undefined,
  });
  const worktrees = {
    make: ({ item }) => ({
      ok: true,
      reason: null,
      worktree: `/wt/${item.key}`,
      branch: `recipe/${item.key}`,
      head: "HEAD",
    }),
    state: () => ({ exists: true, clean: false, commits: 1 }),
    remove: () => ({ ok: true, reason: null }),
  };
  const lookupRun = (id) => ({
    runId: id,
    role: roles.get(id) ?? "implementer",
    cwd: `/wt/${id}`,
    worktree: `/wt/${id}`,
    branch: `recipe/${id}`,
    sessionDir: "/wt/sessions",
    sessionId: id,
  });
  return { harness, runGate, worktrees, newRunId: (item) => `run-${item.key}`, lookupRun };
}

export function runThroughRunner(graph, runs, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-fake-run-"));
  const roles = new Proxy(
    {},
    { get: (_, name) => (typeof name === "string" ? { prompt: "", tools: [], thinking: "", acceptance: null } : undefined) },
  );
  const deps = fakeDeps(runs);
  const port = createPort({
    runDir: path.join(dir, "runner"),
    cwd: dir,
    config: { stateDir: path.join(dir, "state"), roles },
    harnessName: "fake",
    harness: deps.harness,
    deps,
  });
  return graph(Object.freeze(args), port);
}
