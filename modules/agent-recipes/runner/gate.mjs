import { spawn } from "node:child_process";
import { killTree, watchTree } from "./tree-kill.mjs";

const DEFAULT_TIMEOUT_MS = 600000;
const TAIL_CHARS = 1500;

const parseJson = (stdout) => {
  try {
    return { value: JSON.parse(stdout.trim()) };
  } catch (error) {
    return { problem: `gate output is not JSON: ${error.message}` };
  }
};

function runCommand(gate, { cwd, env, signal }) {
  const started = Date.now();
  const timeoutMs = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", gate.command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let combined = "";
    let timedOut = false;
    let killing = null;
    let settled = false;
    let timer;
    const watcher = watchTree(child.pid, { intervalMs: 500 });

    const stop = () => {
      if (killing || settled) return;
      killing = killTree(child.pid, { groups: [...watcher.groups()] }).catch(() => {});
    };

    const finish = async (exit, spawnProblem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (killing) await killing;
      watcher.stop();
      const result = {
        ran: true,
        exit,
        timedOut,
        ms: Date.now() - started,
        tail: combined.slice(-TAIL_CHARS),
        value: undefined,
        problem: spawnProblem,
      };
      if (gate.output === "json") {
        const parsed = parseJson(stdout);
        if ("value" in parsed) result.value = parsed.value;
        else result.problem ??= parsed.problem;
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      combined += chunk;
    });
    child.stderr.on("data", (chunk) => {
      combined += chunk;
    });
    child.on("error", (error) => finish(1, `gate failed to start: ${error.message}`));
    // A surviving grandchild can hold the pipes open, so output is only waited
    // for briefly once the shell itself has exited.
    child.on("exit", (code, sig) => {
      const exit = code ?? (sig ? 128 : 1);
      const closed = new Promise((done) => child.on("close", done));
      Promise.race([closed, new Promise((done) => setTimeout(done, 300))]).then(() =>
        finish(exit),
      );
    });
  });
}

async function runCheck(gate, { cwd, item, outcome }) {
  const started = Date.now();
  const timeoutMs = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const raced = await Promise.race([
      Promise.resolve(gate.check({ cwd, item, outcome })).then((value) => ({ value })),
      timeout,
    ]);
    const ms = Date.now() - started;
    if (raced.timedOut) {
      return {
        ran: true,
        exit: 1,
        timedOut: true,
        ms,
        tail: "",
        value: undefined,
        problem: `gate check timed out after ${timeoutMs} ms`,
      };
    }
    return { ran: true, exit: 0, timedOut: false, ms, tail: "", value: raced.value, problem: undefined };
  } catch (error) {
    const message = error?.message ?? String(error);
    return {
      ran: true,
      exit: 1,
      timedOut: false,
      ms: Date.now() - started,
      tail: message.slice(-TAIL_CHARS),
      value: undefined,
      problem: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runGate(gate, { cwd, env = process.env, item, outcome, signal } = {}) {
  if (typeof gate.check === "function") return runCheck(gate, { cwd, item, outcome });
  return runCommand(gate, { cwd, env, signal });
}
