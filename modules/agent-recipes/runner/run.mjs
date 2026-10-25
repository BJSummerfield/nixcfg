/**
 * Runs one recipe graph to its end: sets up the task directory, keeps
 * status.json and the board current, writes the receipt, and turns a stop
 * request, a signal or the deadline into a clean `stopped`.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { procStartTime } from "./limits.mjs";
import { createPort, killUnfinished } from "./port.mjs";
import { sweep, sweepFiles } from "./worktree.mjs";

const STOP_GRACE_MS = 15000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const statusPath = (taskDir) => path.join(taskDir, "runner", "status.json");
export const receiptPath = (taskDir) => path.join(taskDir, "receipt.json");

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// Children that started and never settled when the run stopped.
function interruptedKeys(runDir) {
  const records = readRecords(path.join(runDir, "children.jsonl"));
  const settled = new Set(records.filter((r) => r.type === "settle").map((r) => r.key));
  return [...new Set(records.filter((r) => r.type === "start" && !settled.has(r.key)).map((r) => r.key))];
}

export function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

// A pid that is gone, a zombie, or reused by another process all count as dead.
export function processLives(pid, pidStart) {
  if (!pid) return false;
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
  return pidStart == null || procStartTime(pid) === String(pidStart);
}

export const runIsAlive = (status) => Boolean(status) && processLives(status.pid, status.pidStart);

export function taskDirOf(args) {
  const dir = args?.dir ?? args?.plan;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("args.dir (or args.plan) must be an absolute task directory");
  }
  return path.resolve(dir);
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "").replace(/[-:T]/g, "");
}

// A runner.log that is already open as the run's stdout stays where it is: its
// text is copied to the old directory and the file is emptied in place.
function setAside(taskDir) {
  const runDir = path.join(taskDir, "runner");
  let names;
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return null;
  }
  if (names.every((name) => name === "runner.log")) return null;
  const base = `${runDir}.${stamp(Date.now())}`;
  let target = base;
  for (let n = 1; fs.existsSync(target); n += 1) target = `${base}-${n}`;
  fs.mkdirSync(target);
  for (const name of names) {
    const from = path.join(runDir, name);
    if (name === "runner.log") {
      fs.copyFileSync(from, path.join(target, name));
      fs.truncateSync(from, 0);
    } else {
      fs.renameSync(from, path.join(target, name));
    }
  }
  return target;
}

async function loadModule(file, what) {
  try {
    return await import(file);
  } catch (error) {
    throw new Error(`cannot load the ${what} (${file}): ${error.message}`);
  }
}

export async function runRecipe(opts) {
  const { harnessName: givenHarness, resume = false, signal } = opts;
  const config = opts.config ?? loadConfig();
  let { recipe, graphPath, args, cwd, timeoutMs, maxChildren, concurrency } = opts;
  let harnessName = givenHarness ?? "pi";

  const taskDir = opts.taskDir ? path.resolve(opts.taskDir) : taskDirOf(args);
  const runDir = path.join(taskDir, "runner");
  const previous = readJson(statusPath(taskDir));
  if (previous?.state === "running" && runIsAlive(previous)) {
    throw new Error(`a run is already going in ${taskDir} (pid ${previous.pid})`);
  }
  if (resume) {
    if (!previous) throw new Error(`nothing to resume in ${taskDir}: no runner/status.json`);
    recipe = previous.recipe;
    args = previous.args;
    cwd = previous.cwd;
    harnessName = previous.harness ?? harnessName;
    graphPath ??= previous.graph ?? undefined;
    timeoutMs ??= previous.timeoutMs ?? undefined;
    maxChildren ??= previous.maxChildren ?? undefined;
    concurrency ??= previous.concurrency ?? undefined;
  }
  if (!NAME.test(String(recipe ?? ""))) throw new Error(`bad recipe name: ${recipe}`);
  if (!NAME.test(harnessName)) throw new Error(`bad harness name: ${harnessName}`);
  cwd = path.resolve(cwd ?? process.cwd());
  const graphFile = graphPath
    ? pathToFileURL(path.resolve(graphPath)).href
    : new URL(`../${recipe}/graph.mjs`, import.meta.url).href;
  const graph = (await loadModule(graphFile, "graph")).default;
  if (typeof graph !== "function") throw new Error(`${graphFile} has no default export function`);
  const harness = await loadModule(new URL(`./harness/${harnessName}.mjs`, import.meta.url).href, "harness");

  if (resume) await killUnfinished(runDir, { stateDir: config.stateDir });
  else setAside(taskDir);
  fs.mkdirSync(runDir, { recursive: true });
  fs.rmSync(receiptPath(taskDir), { force: true });
  try {
    sweep(config.worktreeDir, cwd);
    sweepFiles(path.join(config.stateDir, "children"));
  } catch {
    // Housekeeping only; a failed sweep must not stop the run.
  }

  const childrenLog = path.join(runDir, "children.jsonl");
  const replay = resume ? readRecords(childrenLog) : [];
  // The port appends only when a child starts; a reader that sees the status
  // below say running must already find the log.
  fs.appendFileSync(childrenLog, "");

  const status = {
    recipe,
    harness: harnessName,
    graph: graphPath ? path.resolve(graphPath) : null,
    state: "running",
    pid: process.pid,
    pidStart: procStartTime(process.pid),
    startedAt: new Date().toISOString(),
    lastUpdate: null,
    args,
    cwd,
    timeoutMs: timeoutMs ?? null,
    maxChildren: maxChildren ?? null,
    concurrency: concurrency ?? null,
    board: null,
    error: null,
  };
  const flush = () => {
    status.lastUpdate = new Date().toISOString();
    writeJsonAtomic(statusPath(taskDir), status);
  };
  flush();

  const controller = new AbortController();
  let stopWhy = null;
  const stop = (why) => {
    if (stopWhy) return;
    stopWhy = why;
    controller.abort();
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  const onSignal = () => stop("stop requested");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  if (signal?.aborted) onSignal();
  else signal?.addEventListener("abort", onSignal, { once: true });
  const deadline =
    timeoutMs > 0 ? setTimeout(() => stop(`deadline of ${timeoutMs} ms reached`), timeoutMs) : null;

  const port = createPort({
    runDir,
    cwd,
    config,
    harnessName,
    harness,
    replay,
    maxChildren,
    concurrency,
    signal: controller.signal,
    keepWorktrees: true,
    onBoard: (view) => {
      status.board = view;
      flush();
    },
  });

  const finished = (async () => graph(Object.freeze(args), port))().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const graceOver = new Promise((resolve) => {
    const arm = () => setTimeout(() => resolve({ gaveUp: true }), STOP_GRACE_MS).unref();
    if (controller.signal.aborted) arm();
    else controller.signal.addEventListener("abort", arm, { once: true });
  });
  const outcome = await Promise.race([finished, graceOver]);

  clearTimeout(deadline);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  signal?.removeEventListener("abort", onSignal);

  let receipt;
  if (stopWhy) {
    status.state = "stopped";
    status.error = stopWhy;
    receipt = { stopped: true, failed: `stopped: ${stopWhy}`, interrupted: interruptedKeys(runDir), board: status.board };
  } else if (outcome.error) {
    status.state = "failed";
    status.error = String(outcome.error?.message ?? outcome.error);
    receipt = { failed: `failed: ${status.error}`, board: status.board };
  } else {
    status.state = "complete";
    receipt = outcome.value ?? {};
  }
  writeJsonAtomic(receiptPath(taskDir), receipt);
  flush();
  return { state: status.state, error: status.error, receipt, taskDir };
}
