import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "./cli.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-cli-"));
const CLOCK = Date.parse("2026-01-02T03:04:05.000Z");
const STAMP = new Date(CLOCK).toISOString().replace(/[:.]/g, "-");
const METRICS_URL = "http://127.0.0.1:1150/ops/metrics";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const modelsFile = path.join(tmp, "models.json");
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1150/v1" } } }));
const configFile = path.join(tmp, "roles.json");
fs.writeFileSync(configFile, JSON.stringify({ model: "local/smoke" }));

function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts = {}) => {
    const call = { file, args, opts, code: null };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = 900000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const timer = setTimeout(() => {
      call.code = opts.signal?.aborted ? 130 : 0;
      child.emit("exit", call.code, null);
    }, 20);
    timer.unref();
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

async function runCli(argv, deps) {
  const prevConfig = process.env.RECIPE_RUNNER_CONFIG;
  process.env.RECIPE_RUNNER_CONFIG = configFile;
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const code = await main(argv, { clock: () => CLOCK, modelsFile, ...deps });
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    if (prevConfig === undefined) delete process.env.RECIPE_RUNNER_CONFIG;
    else process.env.RECIPE_RUNNER_CONFIG = prevConfig;
  }
}

const USAGE = { prompt: 120, cached: 40, output: 30 };
const okTest = {
  name: "ok",
  run: async () => ({ name: "ok", pass: true, ms: 1500, children: 1, usage: { ...USAGE }, detail: "" }),
};
const badTest = {
  name: "bad",
  run: async () => ({ name: "bad", pass: false, ms: 2500, children: 1, usage: { ...USAGE }, detail: "the run failed: boom" }),
};
const throwTest = {
  name: "boom",
  run: async () => {
    throw new Error("threw mid-test");
  },
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a busy engine refuses with exit 3 and its running and waiting counts", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return { ok: true, text: async () => "ninfer_running 1\nninfer_waiting 2\n" };
  };
  const { code, stderr } = await runCli(["--only", "ok"], { TESTS: [okTest], spawn: fakeSpawn(), fetch });
  assert.equal(code, 3);
  assert.deepEqual(urls, [METRICS_URL]);
  assert.match(stderr, /1 running/);
  assert.match(stderr, /2 waiting/);
  assert.match(stderr, /--force/);
});

test("--force skips the engine check and lets a passing run exit 0", async () => {
  let called = 0;
  const fetch = async () => {
    called++;
    throw new Error("fetch should not be called");
  };
  const out = fs.mkdtempSync(path.join(tmp, "force-"));
  const { code } = await runCli(["--force", "--out", out], { TESTS: [okTest], spawn: fakeSpawn(), fetch });
  assert.equal(code, 0);
  assert.equal(called, 0);
  assert.ok(fs.existsSync(path.join(out, `recipe-smoke-${STAMP}.json`)));
  assert.ok(fs.existsSync(path.join(out, `recipe-smoke-${STAMP}.txt`)));
});

test("an unreachable metrics URL refuses with exit 3", async () => {
  const fetch = async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  };
  const { code, stderr } = await runCli([], { TESTS: [okTest], spawn: fakeSpawn(), fetch });
  assert.equal(code, 3);
  assert.match(stderr, /cannot check the engine metrics/);
  assert.match(stderr, /ECONNREFUSED/);
  assert.match(stderr, /--force/);
});

test("the report covers a pass, a failure and a throw, and the result files are copied", async () => {
  const out = fs.mkdtempSync(path.join(tmp, "report-"));
  const spawn = fakeSpawn();
  const { code, stdout } = await runCli(["--force", "--out", out], { TESTS: [okTest, badTest, throwTest], spawn });
  assert.equal(code, 1);
  assert.equal(spawn.calls.length, 0);
  const jsonPath = path.join(out, `recipe-smoke-${STAMP}.json`);
  const txtPath = path.join(out, `recipe-smoke-${STAMP}.txt`);
  assert.ok(stdout.includes(jsonPath));
  assert.ok(stdout.includes(txtPath));
  const record = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(record.startedAt, new Date(CLOCK).toISOString());
  assert.equal(record.finishedAt, new Date(CLOCK).toISOString());
  assert.equal(record.host, os.hostname());
  assert.equal(record.full, false);
  assert.deepEqual(
    record.results.map((r) => [r.name, r.pass]),
    [
      ["ok", true],
      ["bad", false],
      ["boom", false],
    ],
  );
  assert.match(record.results[1].detail, /boom/);
  assert.match(record.results[2].detail, /threw mid-test/);
  const table = fs.readFileSync(txtPath, "utf8");
  assert.ok(stdout.includes(table.trim()), "the table is printed and copied");
  assert.match(table, /ok\s+pass/);
  assert.match(table, /bad\s+FAIL/);
  assert.match(table, /boom\s+FAIL/);
  assert.match(table, /1p 2f 0s/);
  const entries = fs.readdirSync(out, { withFileTypes: true });
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [path.basename(txtPath), path.basename(jsonPath)].sort(),
    "only the copied results remain in --out",
  );
});

test("--keep keeps the workdir, and without it the workdir is removed", async () => {
  const keepOut = fs.mkdtempSync(path.join(tmp, "keep-"));
  const { code } = await runCli(["--force", "--keep", "--out", keepOut], { TESTS: [okTest], spawn: fakeSpawn() });
  assert.equal(code, 0);
  const kept = fs.readdirSync(keepOut, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.equal(kept.length, 1);
  assert.match(kept[0].name, /^recipe-smoke-/);
  assert.ok(fs.existsSync(path.join(keepOut, kept[0].name, "result.json")));
  assert.ok(fs.existsSync(path.join(keepOut, kept[0].name, "result.txt")));

  const goneOut = fs.mkdtempSync(path.join(tmp, "gone-"));
  await runCli(["--force", "--out", goneOut], { TESTS: [okTest], spawn: fakeSpawn() });
  const dirs = fs.readdirSync(goneOut, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.deepEqual(dirs, []);
});

test("an interrupt stops the tracked run, skips the rest and still writes the results", async () => {
  const out = fs.mkdtempSync(path.join(tmp, "signal-"));
  const runDir = path.join(out, "tracked-run");
  const second = {
    name: "second",
    run: async (ctx) => {
      ctx.track(runDir);
      process.kill(process.pid, "SIGINT");
      await sleep(100);
      return { name: "second", pass: false, ms: 100, children: 0, usage: { prompt: 0, cached: 0, output: 0 }, detail: "interrupted" };
    },
  };
  const third = {
    name: "third",
    run: async () => ({ name: "third", pass: true, ms: 0, children: 0, usage: { prompt: 0, cached: 0, output: 0 }, detail: "" }),
  };
  const spawn = fakeSpawn();
  const { code, stdout, stderr } = await runCli(["--force", "--out", out], { TESTS: [okTest, second, third], spawn });
  assert.equal(code, 1);
  assert.match(stderr, /interrupt/);
  const stop = spawn.calls.find((c) => c.args[1] === "stop" && c.args[2] === runDir);
  assert.ok(stop, "the tracked run got a stop");
  assert.equal(stop.code, 0, "the stop child ran to completion");
  const record = JSON.parse(fs.readFileSync(path.join(out, `recipe-smoke-${STAMP}.json`), "utf8"));
  assert.deepEqual(
    record.results.map((r) => r.pass),
    [true, false, null],
  );
  assert.match(record.results[2].detail, /skipped/);
  assert.match(stdout, /third\s+skip/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n${e.stack}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`${tests.length} passed`);
