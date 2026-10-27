#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.mjs";
import { createPort, killUnfinished } from "./port.mjs";
import {
  readJson,
  receiptPath,
  runIsAlive,
  runRecipe,
  statusPath,
  taskDirOf,
  writeJsonAtomic,
} from "./run.mjs";

const here = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_OPTIONS = {
  args: { type: "string" },
  cwd: { type: "string" },
  harness: { type: "string" },
  "timeout-ms": { type: "string" },
  "max-children": { type: "string" },
  concurrency: { type: "string" },
  graph: { type: "string" },
};

class UsageError extends Error {}

const number = (value, name) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${name} must be a number`);
  return parsed;
};

function parse(argv, options, positionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${positionals} positional argument(s), got ${parsed.positionals.length}`);
  }
  return parsed;
}

function runInputs(values, recipe) {
  if (values.args === undefined) throw new UsageError("--args <json> is required");
  let args;
  try {
    args = JSON.parse(values.args);
  } catch (error) {
    throw new UsageError(`--args is not JSON: ${error.message}`);
  }
  return {
    recipe,
    args,
    cwd: values.cwd ? path.resolve(values.cwd) : process.cwd(),
    harnessName: values.harness ?? "pi",
    graphPath: values.graph,
    timeoutMs: number(values["timeout-ms"], "--timeout-ms"),
    maxChildren: number(values["max-children"], "--max-children"),
    concurrency: number(values.concurrency, "--concurrency"),
  };
}

const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

async function finish(code) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

async function foreground(inputs) {
  const result = await runRecipe(inputs);
  out({ taskDir: result.taskDir, state: result.state, error: result.error });
  return result.state === "complete" ? 0 : 1;
}

async function detach(taskDir, argv, patienceMs) {
  const logFile = path.join(taskDir, "runner", "runner.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [here, ...argv], { detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + patienceMs;
  while (Date.now() < deadline) {
    const status = readJson(statusPath(taskDir));
    if (status?.pid === child.pid) return { taskDir, pid: child.pid, status: status.state };
    if (exited) break;
    await sleep(50);
  }
  const status = readJson(statusPath(taskDir));
  if (status?.pid === child.pid) return { taskDir, pid: child.pid, status: status.state };
  let tail = "";
  try {
    tail = fs.readFileSync(logFile, "utf8").slice(-1500).trim();
  } catch {
    tail = "";
  }
  throw new Error(`the run did not start${exited ? "" : " in time"}: ${tail}`);
}

async function start(argv) {
  const { values, positionals } = parse(argv, RUN_OPTIONS, 1);
  const inputs = runInputs(values, positionals[0]);
  const taskDir = taskDirOf(inputs.args);
  const forwarded = ["run", inputs.recipe, "--args", JSON.stringify(inputs.args), "--cwd", inputs.cwd, "--harness", inputs.harnessName];
  for (const [flag, value] of [
    ["--timeout-ms", inputs.timeoutMs],
    ["--max-children", inputs.maxChildren],
    ["--concurrency", inputs.concurrency],
    ["--graph", inputs.graphPath && path.resolve(inputs.graphPath)],
  ]) {
    if (value !== undefined) forwarded.push(flag, String(value));
  }
  out(await detach(taskDir, forwarded, 15000));
  return 0;
}

async function run(argv) {
  const { values, positionals } = parse(argv, RUN_OPTIONS, 1);
  return foreground(runInputs(values, positionals[0]));
}

async function resume(argv) {
  const { values, positionals } = parse(argv, { detach: { type: "boolean" } }, 1);
  const taskDir = path.resolve(positionals[0]);
  if (values.detach) {
    out(await detach(taskDir, ["resume", taskDir], 60000));
    return 0;
  }
  return foreground({ resume: true, taskDir, config: loadConfig() });
}

async function wait(argv) {
  const { values, positionals } = parse(argv, { "timeout-ms": { type: "string" } }, 1);
  const taskDir = path.resolve(positionals[0]);
  const limit = number(values["timeout-ms"], "--timeout-ms");
  const began = Date.now();
  const noStatusGraceMs = 10000;
  for (;;) {
    const status = readJson(statusPath(taskDir));
    if (!status) {
      if (!fs.existsSync(path.join(taskDir, "runner")) || Date.now() - began > noStatusGraceMs) {
        throw new UsageError(`no run in ${taskDir}`);
      }
    } else if (status.state !== "running" || !runIsAlive(status)) {
      const receipt =
        readJson(receiptPath(taskDir)) ??
        (status.state === "running"
          ? { stopped: true, reason: "process gone", interrupted: [], board: status.board }
          : { failed: `${status.state}: no receipt`, board: status.board });
      out(receipt);
      return status.state === "complete" ? 0 : 1;
    }
    if (limit !== undefined && Date.now() - began >= limit) {
      out({ failed: "wait timed out", state: status?.state ?? null });
      return 3;
    }
    await sleep(250);
  }
}

async function stop(argv) {
  const { positionals } = parse(argv, {}, 1);
  const taskDir = path.resolve(positionals[0]);
  const status = readJson(statusPath(taskDir));
  if (!status) throw new UsageError(`no run in ${taskDir}`);
  const runDir = path.join(taskDir, "runner");
  if (runIsAlive(status)) {
    process.kill(status.pid, "SIGTERM");
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const now = readJson(statusPath(taskDir));
      if (!runIsAlive(status) || (now && now.state !== "running" && !runIsAlive(now))) break;
      await sleep(200);
    }
    if (runIsAlive(status)) {
      out({ taskDir, pid: status.pid, state: "running", error: "the run did not stop in time" });
      return 1;
    }
  }
  const latest = readJson(statusPath(taskDir)) ?? status;
  if (!runIsAlive(latest)) await killUnfinished(runDir, { stateDir: loadConfig().stateDir });
  if (latest.state === "running") {
    const why = "stop requested (process gone)";
    if (!fs.existsSync(receiptPath(taskDir))) {
      writeJsonAtomic(receiptPath(taskDir), { stopped: true, reason: why, interrupted: [], board: latest.board });
    }
    writeJsonAtomic(statusPath(taskDir), { ...latest, state: "stopped", error: why, lastUpdate: new Date().toISOString() });
  }
  const final = readJson(statusPath(taskDir));
  out({ taskDir, state: final?.state ?? latest.state });
  return 0;
}

async function dispatch(argv) {
  const { values } = parse(
    argv,
    {
      role: { type: "string" },
      brief: { type: "string" },
      "brief-file": { type: "string" },
      output: { type: "string" },
      gate: { type: "string" },
      "gate-json": { type: "boolean" },
      "gate-timeout-ms": { type: "string" },
      worktree: { type: "boolean" },
      base: { type: "string" },
      "keep-worktree": { type: "boolean" },
      "timeout-ms": { type: "string" },
      cwd: { type: "string" },
      dir: { type: "string" },
      harness: { type: "string" },
      "result-file": { type: "string" },
    },
    0,
  );
  if (!values.role) throw new UsageError("--role is required");
  if ((values.brief === undefined) === (values["brief-file"] === undefined)) {
    throw new UsageError("give exactly one of --brief and --brief-file");
  }
  const brief = values.brief ?? fs.readFileSync(values["brief-file"], "utf8");
  const harnessName = values.harness ?? "pi";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(harnessName)) throw new UsageError(`bad harness name: ${harnessName}`);
  const config = loadConfig();
  const harness = await import(new URL(`./harness/${harnessName}.mjs`, import.meta.url).href);
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = path.resolve(values.dir ?? path.join(process.env.TMPDIR || os.tmpdir(), "recipe-dispatch", id));
  fs.mkdirSync(dir, { recursive: true });

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);

  const gateTimeoutMs = number(values["gate-timeout-ms"], "--gate-timeout-ms");
  const item = {
    key: "dispatch",
    agent: values.role,
    task: brief,
    output: values.output,
    gate: values.gate
      ? {
          command: values.gate,
          ...(values["gate-json"] && { output: "json" }),
          ...(gateTimeoutMs !== undefined && { timeoutMs: gateTimeoutMs }),
        }
      : undefined,
    worktree: values.worktree ? true : undefined,
    baseRef: values.base,
    maxRuntimeMs: number(values["timeout-ms"], "--timeout-ms"),
  };
  const port = createPort({
    runDir: dir,
    cwd: path.resolve(values.cwd ?? process.cwd()),
    config,
    harnessName,
    harness,
    signal: controller.signal,
    keepWorktrees: Boolean(values["keep-worktree"]),
  });
  const result = await port.runOne(item);
  if (values["result-file"]) writeJsonAtomic(path.resolve(values["result-file"]), result);
  out(result);
  return 0;
}

const COMMANDS = { start, run, resume, wait, stop, dispatch };

export async function main(argv) {
  const [command, ...rest] = argv;
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`usage: recipe-run <${Object.keys(COMMANDS).join("|")}> ...\n`);
    return 2;
  }
  try {
    return await handler(rest);
  } catch (error) {
    process.stderr.write(`recipe-run ${command}: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

const entry = process.argv[1];
if (entry && fs.realpathSync(entry) === fs.realpathSync(here)) {
  finish(await main(process.argv.slice(2)));
}
