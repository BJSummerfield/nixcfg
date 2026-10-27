import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FIXTURE_TAG } from "./fixtures/tinycalc/calc.js";
import { setupPlan, setupRepo, withRoleOverrides } from "./core.mjs";
import { processLives, readJson, readRecords, receiptPath, runIsAlive, statusPath } from "../runner/run.mjs";

export const HANDOFF_TOKENS = 8500;
export const HANDOFF_RESERVE = 6000;

const EMPTY_USAGE = { prompt: 0, cached: 0, output: 0 };
const RESEARCH_TIMEOUT_MS = 5400000;
const IMPLEMENT_TIMEOUT_MS = 14400000;
const WAIT_TIMEOUT_MS = 7200000;
const CHILD_START_TIMEOUT_MS = 300000;
// A dispatch normally takes seconds; the cap exists to catch a runaway loop before it burns the 20-minute default.
export const DISPATCH_TIMEOUT_MS = 300000;
const PIDS_GONE_TIMEOUT_MS = 20000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function statsFromRecords(records) {
  let children = 0;
  const usage = { ...EMPTY_USAGE };
  for (const r of records ?? []) {
    if (r?.type === "start") children += 1;
    if (r?.type === "settle") {
      const u = r.result?.usage ?? {};
      usage.prompt += num(u.prompt);
      usage.cached += num(u.cached);
      usage.output += num(u.output);
    }
  }
  return { children, usage };
}

export function checkDispatch(result, outputText, tag) {
  if (!result) return { pass: false, detail: "no dispatch result file" };
  if (result.ok !== true) return { pass: false, detail: `dispatch was not ok: ${result.error ?? result.status ?? "unknown"}` };
  const u = result.usage ?? {};
  if (num(u.prompt) <= 0 || num(u.output) <= 0) {
    return { pass: false, detail: `usage shows prompt ${num(u.prompt)} and output ${num(u.output)} tokens` };
  }
  if (num(u.turns) < 2) {
    return { pass: false, detail: `only ${num(u.turns)} assistant turn(s); the brief needs a tool round trip` };
  }
  if (outputText === null) return { pass: false, detail: "the output file was not written" };
  if (!outputText.includes(tag)) return { pass: false, detail: "the output does not state the fixture tag" };
  return { pass: true, detail: "" };
}

export function checkDispatchModel(recorded, expected) {
  if (recorded === null) return { pass: false, detail: "no model recorded in the spawn log" };
  if (recorded !== expected) return { pass: false, detail: `the child ran on ${recorded}, not ${expected}` };
  return { pass: true, detail: "" };
}

// The harness records the child's argv in spawn.jsonl under the run directory,
// so the model can only come out of there.
export function spawnModel(runDir) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "spawn.jsonl") files.push(p);
    }
  };
  walk(runDir);
  for (const file of files) {
    for (const record of readRecords(file)) {
      const argv = record?.argv;
      if (!Array.isArray(argv)) continue;
      const i = argv.indexOf("--model");
      if (i >= 0 && typeof argv[i + 1] === "string") return argv[i + 1];
    }
  }
  return null;
}

export function checkResearch(receipt, outputText) {
  if (!receipt) return { pass: false, detail: "no receipt" };
  if (receipt.stopped) return { pass: false, detail: `the run stopped: ${receipt.reason ?? "stopped"}` };
  if (receipt.failed) return { pass: false, detail: `the run failed: ${oneLine(receipt.failed)}` };
  const open = (receipt.open ?? []).map(String).filter((l) => /fail/i.test(l));
  if (open.length) return { pass: false, detail: `open line about a failed step: ${oneLine(open[0])}` };
  if (typeof receipt.output !== "string" || !receipt.output) return { pass: false, detail: "the receipt names no output" };
  if (outputText === null) return { pass: false, detail: `output ${receipt.output} does not exist` };
  if (!/\badd\b/.test(outputText)) return { pass: false, detail: "the output does not mention add" };
  return { pass: true, detail: "" };
}

export function checkMerged(receipt, taskIds) {
  if (!receipt) return { pass: false, detail: "no receipt" };
  if (receipt.stopped) return { pass: false, detail: `the run stopped: ${receipt.reason ?? "stopped"}` };
  if (receipt.failed) return { pass: false, detail: `the run failed: ${oneLine(receipt.failed)}` };
  const merged = new Set(receipt.merged ?? []);
  const missing = taskIds.filter((id) => !merged.has(id));
  if (missing.length) return { pass: false, detail: `tasks not merged: ${missing.join(", ")}` };
  return { pass: true, detail: "" };
}

export function checkImplement(receipt, taskIds, nodeTestPassed) {
  const merged = checkMerged(receipt, taskIds);
  if (!merged.pass) return merged;
  const left = receipt?.left ?? [];
  if (left.length) {
    return { pass: false, detail: `left is not empty: ${left.map((l) => l.id ?? l.branch ?? "?").join(", ")}` };
  }
  if (nodeTestPassed !== true) return { pass: false, detail: "node --test failed on the integration branch" };
  return { pass: true, detail: "" };
}

export function checkHandoff(records, receipt, taskIds) {
  const recs = records ?? [];
  const relay = recs.find((r) => r?.type === "handoff" && r?.as === "relay");
  if (!relay) return { pass: false, detail: "no relayed handoff in the children log" };
  const settled = recs.some((r) => r?.type === "settle" && r?.key === relay.key && r?.runId === relay.by);
  if (!settled) return { pass: false, detail: "the relayed child of the handoff never settled" };
  const merged = checkMerged(receipt, taskIds);
  return { pass: true, detail: merged.pass ? "merged" : `not merged: ${merged.detail}` };
}

export function checkStop(receipt) {
  if (!receipt) return { pass: false, detail: "no receipt after the stop" };
  if (receipt.stopped !== true) {
    return { pass: false, detail: `receipt says ${receipt.failed ? `failed: ${oneLine(receipt.failed)}` : JSON.stringify(receipt.stopped)}, not stopped` };
  }
  if (!Array.isArray(receipt.interrupted) || receipt.interrupted.length === 0) {
    return { pass: false, detail: "the receipt lists no interrupted children" };
  }
  return { pass: true, detail: "" };
}

export function stopReady(records) {
  const recs = records ?? [];
  const settled = new Set(recs.filter((r) => r?.type === "settle").map((r) => r.runId));
  let seenSettle = false;
  for (const r of recs) {
    if (r?.type === "settle") seenSettle = true;
    else if (r?.type === "start" && seenSettle && !settled.has(r.runId)) return true;
  }
  return false;
}

export function settledAgain(before, after) {
  const runIds = new Set((before ?? []).map((r) => r?.runId));
  const settled = new Set((before ?? []).filter((r) => r?.type === "settle").map((r) => r.key));
  const again = new Set();
  for (const r of after ?? []) {
    if (r?.type === "start" && !runIds.has(r.runId) && settled.has(r.key)) again.add(r.key);
  }
  return [...again];
}

function makeResult(name, began, pass, detail, stats) {
  return {
    name,
    pass,
    ms: Date.now() - began,
    children: stats?.children ?? 0,
    usage: { ...EMPTY_USAGE, ...(stats?.usage ?? {}) },
    detail: oneLine(detail),
  };
}

function subDir(ctx, name) {
  const dir = path.join(ctx.workdir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runnerOpts(env, cwd, signal) {
  return { env, cwd, signal };
}

function runnerConfigSource(ctx) {
  return ctx.env?.RECIPE_RUNNER_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "recipes", "roles.json");
}

function writeRunnerConfig(ctx, sub, overrides = null) {
  const config = JSON.parse(fs.readFileSync(runnerConfigSource(ctx), "utf8"));
  const patched = overrides ? withRoleOverrides(config, overrides) : config;
  patched.worktreeDir = path.join(sub, "worktrees");
  const file = path.join(sub, "roles.json");
  fs.writeFileSync(file, JSON.stringify(patched, null, 2));
  return file;
}

const childrenLog = (taskDir) => path.join(taskDir, "runner", "children.jsonl");

function outputText(taskDir, receipt) {
  if (typeof receipt?.output !== "string" || !receipt.output) return null;
  try {
    return fs.readFileSync(path.resolve(taskDir, receipt.output), "utf8");
  } catch {
    return null;
  }
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

export function nodeTestOnBranch(repo, branch, wt) {
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  const add = git("worktree", "add", "--detach", wt, branch);
  if (add.status !== 0) return { passed: false, error: `cannot check out ${branch}: ${oneLine(add.stderr || add.stdout)}` };
  try {
    const run = spawnSync(process.execPath, ["--test"], { cwd: wt, encoding: "utf8" });
    if (run.status !== 0) {
      return { passed: false, error: `node --test failed on ${branch}: ${oneLine(`${run.stdout ?? ""} ${run.stderr ?? ""}`).slice(-300)}` };
    }
    const multiplyCheck = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(path.join(wt, "calc.js"))}); process.exit(typeof m.multiply === "function" ? 0 : 1);`],
      { cwd: wt, encoding: "utf8" },
    );
    if (multiplyCheck.status !== 0) return { passed: false, error: `calc.js on ${branch} does not export multiply` };
    return { passed: true, error: "" };
  } finally {
    git("worktree", "remove", "--force", wt);
  }
}

async function waitFor(file, predicate, deadlineMs, signal) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) return false;
    if (predicate(readRecords(file))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

async function allGone(pids, signal) {
  const deadline = Date.now() + PIDS_GONE_TIMEOUT_MS;
  for (;;) {
    const alive = pids.filter((p) => processLives(p.pid, p.start));
    if (alive.length === 0) return { gone: true, alive: [] };
    if (signal?.aborted || Date.now() >= deadline) return { gone: false, alive };
    await sleep(500);
  }
}

function researchSetup(ctx, sub) {
  const repo = path.join(sub, "repo");
  setupRepo(ctx.fixturesDir, repo);
  const taskDir = path.join(sub, "task");
  fs.mkdirSync(taskDir, { recursive: true });
  const fixture = JSON.parse(fs.readFileSync(path.join(ctx.fixturesDir, "research.json"), "utf8"));
  const q = ctx.full ? fixture.full : fixture;
  const args = { dir: taskDir, goal: q.goal, source: q.source, repo };
  return { repo, taskDir, args };
}

function implementSetup(ctx, sub, full) {
  const repo = path.join(sub, "repo");
  setupRepo(ctx.fixturesDir, repo);
  const plan = path.join(sub, "plan");
  setupPlan(ctx.fixturesDir, plan);
  if (!full) fs.rmSync(path.join(plan, "tasks", "power.md"), { force: true });
  return { repo, plan, taskIds: full ? ["multiply", "power"] : ["multiply"] };
}

function implementCheck(name, began, sub, repo, plan, taskIds) {
  const receipt = readJson(receiptPath(plan));
  const t = receipt?.branch
    ? nodeTestOnBranch(repo, receipt.branch, path.join(sub, "integration"))
    : { passed: false, error: receipt ? "the receipt names no integration branch" : "no receipt" };
  const check = checkImplement(receipt, taskIds, t.passed);
  const detail =
    check.pass || check.detail !== "node --test failed on the integration branch" || !t.error
      ? check.detail
      : t.error;
  return makeResult(name, began, check.pass, detail, statsFromRecords(readRecords(childrenLog(plan))));
}

const DISPATCH_ROLE = "scout";
const dispatchBrief = "Read calc.js in this repository and state the value of its exported constant FIXTURE_TAG.";

async function dispatchTest(name, ctx, harness) {
  const began = Date.now();
  try {
    const sub = subDir(ctx, name);
    const env = { ...ctx.env, RECIPE_RUNNER_CONFIG: writeRunnerConfig(ctx, sub) };
    const runDir = path.join(sub, "run");
    const repo = path.join(sub, "repo");
    const outFile = path.join(sub, "output.md");
    const resultFile = path.join(sub, "dispatch-result.json");
    const briefFile = path.join(sub, "brief.md");
    fs.writeFileSync(briefFile, dispatchBrief);
    setupRepo(ctx.fixturesDir, repo);
    await ctx.runner(
      [
        "dispatch",
        "--role",
        DISPATCH_ROLE,
        "--brief-file",
        briefFile,
        "--output",
        outFile,
        "--result-file",
        resultFile,
        "--dir",
        runDir,
        "--cwd",
        repo,
        "--timeout-ms",
        String(DISPATCH_TIMEOUT_MS),
        ...(harness ? ["--harness", harness] : []),
      ],
      runnerOpts(env, repo, ctx.signal),
    );
    const result = readJson(resultFile);
    const stats = result
      ? {
          children: 1,
          usage: { prompt: num(result.usage?.prompt), cached: num(result.usage?.cached), output: num(result.usage?.output) },
        }
      : undefined;
    const config = readJson(path.join(sub, "roles.json"));
    const role = config?.roles?.[DISPATCH_ROLE] ?? {};
    const expectedModel = harness ? role.claude?.model : (role.model ?? config?.model);
    const check = checkDispatch(result, fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null, FIXTURE_TAG);
    const modelCheck = checkDispatchModel(spawnModel(runDir), expectedModel);
    const pass = check.pass && modelCheck.pass;
    const detail = pass ? "" : modelCheck.pass ? check.detail : check.pass ? modelCheck.detail : `${check.detail}; ${modelCheck.detail}`;
    return makeResult(name, began, pass, detail, stats);
  } catch (error) {
    return makeResult(name, began, false, error.message);
  }
}

async function researchTest(ctx) {
  const name = "research";
  const began = Date.now();
  try {
    const sub = subDir(ctx, name);
    const env = { ...ctx.env, RECIPE_RUNNER_CONFIG: writeRunnerConfig(ctx, sub) };
    const { repo, taskDir, args } = researchSetup(ctx, sub);
    await ctx.runner(
      ["run", name, "--args", JSON.stringify(args), "--cwd", repo, "--timeout-ms", String(RESEARCH_TIMEOUT_MS)],
      runnerOpts(env, repo, ctx.signal),
    );
    const receipt = readJson(receiptPath(taskDir));
    const check = checkResearch(receipt, outputText(taskDir, receipt));
    return makeResult(name, began, check.pass, check.detail, statsFromRecords(readRecords(childrenLog(taskDir))));
  } catch (error) {
    return makeResult(name, began, false, error.message);
  }
}

async function implementTest(ctx) {
  const name = "implement";
  const began = Date.now();
  try {
    const sub = subDir(ctx, name);
    const env = { ...ctx.env, RECIPE_RUNNER_CONFIG: writeRunnerConfig(ctx, sub) };
    const { repo, plan, taskIds } = implementSetup(ctx, sub, ctx.full);
    await ctx.runner(
      ["run", name, "--args", JSON.stringify({ plan, repo }), "--cwd", repo, "--timeout-ms", String(IMPLEMENT_TIMEOUT_MS)],
      runnerOpts(env, repo, ctx.signal),
    );
    return implementCheck(name, began, sub, repo, plan, taskIds);
  } catch (error) {
    return makeResult(name, began, false, error.message);
  }
}

async function handoffTest(ctx) {
  const name = "handoff";
  const began = Date.now();
  try {
    const sub = subDir(ctx, name);
    const env = {
      ...ctx.env,
      RECIPE_RUNNER_CONFIG: writeRunnerConfig(ctx, sub, {
        implementer: { budget: { tokens: HANDOFF_TOKENS, reserve: HANDOFF_RESERVE, action: "commit" } },
      }),
    };
    const { repo, plan, taskIds } = implementSetup(ctx, sub, false);
    await ctx.runner(
      ["run", "implement", "--args", JSON.stringify({ plan, repo }), "--cwd", repo, "--timeout-ms", String(IMPLEMENT_TIMEOUT_MS)],
      { env, cwd: repo, signal: ctx.signal },
    );
    const records = readRecords(childrenLog(plan));
    const check = checkHandoff(records, readJson(receiptPath(plan)), taskIds);
    return makeResult(name, began, check.pass, check.detail, statsFromRecords(records));
  } catch (error) {
    return makeResult(name, began, false, error.message);
  }
}

async function stopResumeTest(ctx) {
  const name = "stop-resume";
  const began = Date.now();
  const sub = subDir(ctx, name);
  let env = null;
  let setup = null;
  try {
    env = { ...ctx.env, RECIPE_RUNNER_CONFIG: writeRunnerConfig(ctx, sub) };
    setup = researchSetup(ctx, sub);
    const { repo, taskDir, args } = setup;
    const started = await ctx.runner(
      ["start", "research", "--args", JSON.stringify(args), "--cwd", repo, "--timeout-ms", String(RESEARCH_TIMEOUT_MS)],
      runnerOpts(env, repo, ctx.signal),
    );
    if (started.code !== 0) {
      return makeResult(name, began, false, `recipe-run start failed: ${oneLine(`${started.stderr} ${started.stdout}`)}`);
    }
    ctx.track?.(taskDir);
    const log = childrenLog(taskDir);
    if (!(await waitFor(log, stopReady, CHILD_START_TIMEOUT_MS, ctx.signal))) {
      return makeResult(name, began, false, "no settled node with a live child before the stop", statsFromRecords(readRecords(log)));
    }
    const stopped = await ctx.runner(["stop", taskDir], runnerOpts(env, repo, ctx.signal));
    const before = readRecords(log);
    const pids = before
      .filter((r) => (r.type === "start" || r.type === "respawn") && r.pid)
      .map((r) => ({ pid: r.pid, start: r.pidStart }));
    const gone = await allGone(pids, ctx.signal);
    const stopCheck = checkStop(readJson(receiptPath(taskDir)));
    const resumed = await ctx.runner(["resume", taskDir, "--detach"], runnerOpts(env, repo, ctx.signal));
    if (resumed.code !== 0) {
      return makeResult(name, began, false, `recipe-run resume failed: ${oneLine(`${resumed.stderr} ${resumed.stdout}`)}`, statsFromRecords(before));
    }
    ctx.track?.(taskDir);
    const waited = await ctx.runner(["wait", taskDir, "--timeout-ms", String(WAIT_TIMEOUT_MS)], runnerOpts(env, repo, ctx.signal));
    const after = readRecords(log);
    const again = settledAgain(before, after);
    const receipt = readJson(receiptPath(taskDir));
    const researchCheck = checkResearch(receipt, outputText(taskDir, receipt));
    const pass = stopped.code === 0 && stopCheck.pass && gone.gone && waited.code === 0 && again.length === 0 && researchCheck.pass;
    let detail = "";
    if (!pass) {
      detail = [
        stopped.code !== 0 ? `stop exited ${stopped.code}` : "",
        stopCheck.detail,
        gone.gone ? "" : `pids still alive: ${gone.alive.map((p) => p.pid).join(", ")}`,
        waited.code !== 0 ? `wait exited ${waited.code}` : "",
        again.length ? `settled nodes restarted: ${again.join(", ")}` : "",
        researchCheck.detail,
      ]
        .filter(Boolean)
        .join("; ");
    }
    return makeResult(name, began, pass, detail, statsFromRecords(after));
  } catch (error) {
    return makeResult(name, began, false, error.message);
  } finally {
    // A timed-out wait or a thrown step leaves the run alive; the stop is a
    // no-op for a run that already ended.
    if (setup && runIsAlive(readJson(statusPath(setup.taskDir)))) {
      await ctx.runner(["stop", setup.taskDir], runnerOpts(env ?? ctx.env, setup.repo ?? process.cwd(), undefined));
    }
  }
}

export const TESTS = [
  { name: "dispatch-pi", run: (ctx) => dispatchTest("dispatch-pi", ctx) },
  { name: "research", run: researchTest },
  { name: "implement", run: implementTest },
  { name: "handoff", run: handoffTest },
  { name: "stop-resume", run: stopResumeTest },
  { name: "dispatch-claude", run: (ctx) => dispatchTest("dispatch-claude", ctx, "claude") },
];
