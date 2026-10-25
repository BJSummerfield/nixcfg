import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "./core.mjs";
import { TESTS as LIVE_TESTS } from "./tests.mjs";
import { loadConfig } from "../runner/config.mjs";
import { killTree } from "../runner/tree-kill.mjs";

const here = fileURLToPath(import.meta.url);
const RUNNER_CLI = fileURLToPath(new URL("../runner/cli.mjs", import.meta.url));
const FIXTURES_DIR = path.join(path.dirname(here), "fixtures");

const EMPTY_USAGE = { prompt: 0, cached: 0, output: 0 };

const skipResult = (name) => ({ name, pass: null, ms: 0, children: 0, usage: { ...EMPTY_USAGE }, detail: "skipped after interrupt" });

// A failed test's transcript is the only evidence left to diagnose it
function moveFailed(workdir, results, failedDir) {
  const failures = results.filter((r) => r.pass === false);
  if (failures.length === 0) return null;
  for (const r of failures) {
    const src = path.join(workdir, r.name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(failedDir, r.name), { recursive: true });
  }
  return failedDir;
}

function makeRunner(deps, livePids) {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = deps.spawn(process.execPath, [RUNNER_CLI, ...args], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        signal: opts.signal,
      });
      if (child.pid !== undefined) livePids.add(child.pid);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) => {
        livePids.delete(child.pid);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

async function engineGuard(deps) {
  const config = loadConfig();
  const [provider] = String(config.model ?? "").split("/");
  if (!provider) throw new Error(`the runner config model is not a <provider>/<model>`);
  let modelsJson;
  try {
    modelsJson = JSON.parse(fs.readFileSync(deps.modelsFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${deps.modelsFile}: ${error.message}`);
  }
  const url = core.metricsUrl(modelsJson, provider);
  let text;
  try {
    const response = await deps.fetch(url);
    if (!response.ok) throw new Error(`metrics returned HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    return { code: 3, message: `cannot check the engine metrics at ${url}: ${error.message}; use --force to run anyway` };
  }
  const load = core.engineLoad(text);
  if (core.isBusy(load)) {
    return { code: 3, message: `the engine is busy: ${load.running} running, ${load.waiting} waiting; use --force to run anyway` };
  }
  return null;
}

export async function main(argv, deps = {}) {
  const d = {
    fetch: (url) => fetch(url),
    TESTS: LIVE_TESTS,
    spawn,
    clock: () => Date.now(),
    modelsFile: path.join(os.homedir(), ".pi", "agent", "models.json"),
    ...deps,
  };

  let opts;
  let selected;
  try {
    opts = core.parseArgs(argv);
    selected = core.selectTests(d.TESTS.map((t) => t.name), opts);
  } catch (error) {
    process.stderr.write(`recipe-smoke: ${error.message}\n`);
    return 2;
  }

  if (!opts.force) {
    const guard = await engineGuard(d).catch((error) => ({ code: 1, message: error.message }));
    if (guard) {
      process.stderr.write(`recipe-smoke: ${guard.message}\n`);
      return guard.code;
    }
  }

  const workdir = core.makeWorkdir(opts.out ?? (process.env.TMPDIR || os.tmpdir()));
  const livePids = new Set();
  const tracked = [];
  const runner = makeRunner(d, livePids);
  const stopped = new Set();
  const stopTracked = async () => {
    for (const dir of [...tracked]) {
      if (stopped.has(dir)) continue;
      stopped.add(dir);
      try {
        await runner(["stop", dir]);
      } catch (error) {
        process.stderr.write(`recipe-smoke: stopping ${dir} failed: ${error.message}\n`);
      }
    }
  };
  const controller = new AbortController();
  const interrupted = { flag: false };
  let cleanup;
  const ctx = {
    env: process.env,
    fixturesDir: FIXTURES_DIR,
    workdir,
    full: opts.full,
    signal: controller.signal,
    runner,
    track: (dir) => tracked.push(dir),
  };

  const onSignal = () => {
    if (interrupted.flag) return;
    interrupted.flag = true;
    process.stderr.write("recipe-smoke: interrupt received, stopping the runs\n");
    controller.abort();
    // The stop children run past this signal, so they get no abort signal of their own.
    cleanup = (async () => {
      await stopTracked();
      for (const pid of [...livePids]) {
        try {
          await killTree(pid);
        } catch (error) {
          process.stderr.write(`recipe-smoke: killing the process tree of ${pid} failed: ${error.message}\n`);
        }
      }
    })();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const startedAt = d.clock();
  const results = [];
  try {
    for (const name of selected) {
      if (interrupted.flag) {
        results.push(skipResult(name));
        continue;
      }
      const test = d.TESTS.find((t) => t.name === name);
      try {
        results.push(await test.run(ctx));
      } catch (error) {
        results.push({ name, pass: false, ms: 0, children: 0, usage: { ...EMPTY_USAGE }, detail: error.message });
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  if (cleanup) await cleanup;
  // a test that timed out or threw leaves its run running, and a normal exit must not leak it
  await stopTracked();

  const finishedAt = d.clock();
  const table = core.formatTable(results);
  const record = core.resultRecord(results, {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    host: os.hostname(),
    full: opts.full,
  });
  const jsonFile = path.join(workdir, "result.json");
  const txtFile = path.join(workdir, "result.txt");
  fs.writeFileSync(jsonFile, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(txtFile, `${table}\n`);
  process.stdout.write(`${table}\n`);

  const destDir = opts.out ?? process.cwd();
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, "-");
  const jsonDest = path.join(destDir, `recipe-smoke-${stamp}.json`);
  const txtDest = path.join(destDir, `recipe-smoke-${stamp}.txt`);
  fs.copyFileSync(jsonFile, jsonDest);
  fs.copyFileSync(txtFile, txtDest);
  process.stdout.write(`${jsonDest}\n${txtDest}\n`);

  const failedDir = moveFailed(workdir, results, path.join(destDir, `recipe-smoke-${stamp}-failed`));
  if (failedDir) process.stdout.write(`${failedDir}\n`);
  core.removeWorkdir(workdir, opts.keep);
  return results.every((r) => r.pass === true) ? 0 : 1;
}

const entry = process.argv[1];
if (entry && fs.realpathSync(entry) === fs.realpathSync(here)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`recipe-smoke: ${error.message}\n`);
      process.exit(1);
    });
}
