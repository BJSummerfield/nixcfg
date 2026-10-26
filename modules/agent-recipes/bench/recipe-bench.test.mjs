import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "./recipe-bench.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-bench-"));
const CLOCK = Date.parse("2026-01-02T03:04:05.000Z");
const METRICS = "ninfer_running 0\nninfer_waiting 0\n";
const BUSY_METRICS = "ninfer_running 2\nninfer_waiting 1\n";

const modelsFile = path.join(tmp, "models.json");
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1150/v1" } } }));
const defaultConfigFile = path.join(tmp, "roles.json");
fs.writeFileSync(defaultConfigFile, JSON.stringify({ model: "local/bench" }));

const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);

const cfgA = path.join(tmp, "cfg-a.json");
const cfgB = path.join(tmp, "cfg-b.json");
fs.writeFileSync(cfgA, "{}");
fs.writeFileSync(cfgB, "{}");

function child(code = 0, stderr = "") {
  const c = new EventEmitter();
  c.pid = 424242;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stderr) c.stderr.emit("data", stderr);
    c.emit("exit", code, null);
  });
  return c;
}

function valueAt(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing ${flag} in ${args.join(" ")}`);
  return args[i + 1];
}

// Keyed by the review file each launch was pointed at, so a run with several
// dispatches gets one scripted answer per dispatch.
function makeSpawn(responses) {
  const launches = [];
  const spawn = (file, args, opts) => {
    const review = valueAt(args, "--output");
    const resultFile = valueAt(args, "--result-file");
    launches.push({ file, args, opts });
    const resp = responses[review];
    if (!resp) throw new Error(`no scripted response for ${review}`);
    const code = resp.code ?? 0;
    if (code !== 0) return child(code, resp.stderr ?? "");
    fs.mkdirSync(path.dirname(review), { recursive: true });
    fs.writeFileSync(review, resp.review ?? "");
    fs.writeFileSync(resultFile, JSON.stringify(resp.result));
    return child();
  };
  spawn.launches = launches;
  return spawn;
}

async function bench(argv, { spawn: spawnDep, busy = false, fetchThrows = false } = {}) {
  const fetch = (url) => {
    if (fetchThrows) throw new Error("the engine check must not run");
    return { ok: true, text: async () => (busy ? BUSY_METRICS : METRICS) };
  };
  const prevConfig = process.env.RECIPE_RUNNER_CONFIG;
  process.env.RECIPE_RUNNER_CONFIG = defaultConfigFile;
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (stdout += String(chunk), true);
  process.stderr.write = (chunk) => (stderr += String(chunk), true);
  try {
    const code = await main(argv, { fetch, spawn: spawnDep, clock: () => CLOCK, modelsFile });
    return { code, stdout, stderr };
  } finally {
    if (prevConfig === undefined) delete process.env.RECIPE_RUNNER_CONFIG;
    else process.env.RECIPE_RUNNER_CONFIG = prevConfig;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function result(verdict, ms, usage = { prompt: 1000, cached: 500, output: 200 }) {
  const r = { ok: true, status: "done", ms, usage };
  if (verdict !== undefined) r.structuredOutput = { verdict };
  return r;
}

function writeCases(file, cases) {
  fs.writeFileSync(file, JSON.stringify({ repo, cases }, null, 2));
  return file;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("argument parsing: repeated configs, the harness suffix, dispatch argv and environment", async () => {
  const cases = writeCases(path.join(tmp, "cases-args.json"), [
    { name: "c1", base: "a", head: "b", task: "do the thing", check: "nix fmt --check x.nix", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-args");
  const resp = {
    [path.join(out, "c1", "a", "1", "review.md")]: { review: "r", result: result("needs-work", 180000) },
    [path.join(out, "c1", "b", "1", "review.md")]: { review: "r", result: result("needs-work", 180000) },
  };
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--config", `b=${cfgB}@claude`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  assert.equal(spawn.launches.length, 2);
  assert.ok(spawn.launches[0].args[0].endsWith(path.join("runner", "cli.mjs")), "the runner cli next to the bench");
  const a = path.join(out, "c1", "a", "1");
  const review = path.join(a, "review.md");
  assert.deepEqual(spawn.launches[0].args.slice(1), [
    "dispatch",
    "--role", "reviewer",
    "--worktree",
    "--base", "b",
    "--cwd", repo,
    "--brief-file", path.join(a, "brief.md"),
    "--output", review,
    "--gate", `recipe-gate verdict ${review}`,
    "--gate-json",
    "--result-file", path.join(a, "result.json"),
    "--dir", a,
    "--timeout-ms", "1200000",
  ]);
  assert.equal(spawn.launches[0].opts.env.RECIPE_RUNNER_CONFIG, cfgA);
  assert.ok(!spawn.launches[0].args.includes("--harness"), "the default harness is not passed");
  assert.equal(spawn.launches[1].opts.env.RECIPE_RUNNER_CONFIG, cfgB);
  assert.deepEqual(spawn.launches[1].args.slice(-2), ["--harness", "claude"]);
});

test("argument parsing: a missing cases file exits 2 without dispatching", async () => {
  const spawn = makeSpawn({});
  const r = await bench([path.join(tmp, "no-such-cases.json"), "--config", `a=${cfgA}`], { spawn });
  assert.equal(r.code, 2);
  assert.equal(spawn.launches.length, 0);
});

test("the brief holds the task, the diff command, the check and the output path", async () => {
  const cases = writeCases(path.join(tmp, "cases-brief.json"), [
    { name: "c1", base: "v1", head: "v2", task: "make tinycalc parse negative numbers", check: "node test.mjs", expect: "needs-work", defects: [] },
  ]);
  const out = path.join(tmp, "out-brief");
  const runDir = path.join(out, "c1", "a", "1");
  const spawn = makeSpawn({ [path.join(runDir, "review.md")]: { review: "r", result: result("clean", 60000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
  assert.match(brief, /Diff on a branch/);
  assert.match(brief, /make tinycalc parse negative numbers/);
  assert.match(brief, /git diff v1\.\.v2/);
  assert.match(brief, /node test\.mjs/);
  assert.match(brief, new RegExp(path.join(runDir, "review.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("scoring: caught, missed, clean on a defect case, false alarm and invalid", async () => {
  const cases = writeCases(path.join(tmp, "cases-score.json"), [
    { name: "caught", base: "a", head: "b", task: "t1", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "missed", base: "a", head: "b", task: "t2", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "cleandefect", base: "a", head: "b", task: "t3", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "control", base: "a", head: "b", task: "t4", check: "c", expect: "clean", defects: [] },
    { name: "invalid", base: "a", head: "b", task: "t5", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-score");
  const resp = {};
  for (const name of ["caught", "missed", "cleandefect", "control", "invalid"]) {
    const review = path.join(out, name, "a", "1", "review.md");
    resp[review] =
      name === "caught"
        ? { review: "the diff has an integer OVERFLOW in parse", result: result("needs-work", 180000) }
        : name === "missed"
          ? { review: "the structure looks fine", result: result("needs-work", 120000) }
          : name === "cleandefect"
            ? { review: "no problems", result: result("clean", 240000) }
            : name === "control"
              ? { review: "this change needs rework", result: result("needs-work", 60000) }
              : { review: "the review is broken", result: result(undefined, 300000) };
  }
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const rows = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a.rows.map((x) => [x.case, x]),
  );
  assert.deepEqual(rows.caught.defects, [{ id: "d1", found: true }]);
  assert.equal(rows.caught.caught, true);
  assert.equal(rows.caught.verdict, "needs-work");
  assert.deepEqual(rows.missed.defects, [{ id: "d1", found: false }]);
  assert.equal(rows.missed.caught, false, "needs-work naming no defect is not caught");
  assert.equal(rows.cleandefect.verdict, "clean");
  assert.equal(rows.cleandefect.caught, false);
  assert.equal(rows.control.falseAlarm, true);
  assert.equal(rows.control.caught, false);
  assert.equal(rows.invalid.verdict, "invalid");
  assert.equal(rows.invalid.defects[0].found, false);
});

test("scoring: a named defect on a clean verdict is not caught", async () => {
  const cases = writeCases(path.join(tmp, "cases-cleanfound.json"), [
    { name: "cleanfound", base: "a", head: "b", task: "t1", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-cleanfound");
  const spawn = makeSpawn({
    [path.join(out, "cleanfound", "a", "1", "review.md")]: {
      review: "the diff has an integer OVERFLOW in parse",
      result: result("clean", 240000),
    },
  });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const entry = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a;
  assert.deepEqual(entry.rows[0].defects, [{ id: "d1", found: true }]);
  assert.equal(entry.rows[0].verdict, "clean");
  assert.equal(entry.rows[0].caught, false, "a named defect on a clean verdict is not caught");
  assert.deepEqual(entry.summary.defectCasesCaught, { caught: 0, total: 1, share: 0 });
});

test("the per-config aggregates and bench.json", async () => {
  const cases = writeCases(path.join(tmp, "cases-agg.json"), [
    { name: "caught", base: "a", head: "b", task: "t1", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "missed", base: "a", head: "b", task: "t2", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "cleandefect", base: "a", head: "b", task: "t3", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "control", base: "a", head: "b", task: "t4", check: "c", expect: "clean", defects: [] },
    { name: "invalid", base: "a", head: "b", task: "t5", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-agg");
  const resp = {};
  for (const name of ["caught", "missed", "cleandefect", "control", "invalid"]) {
    const review = path.join(out, name, "a", "1", "review.md");
    resp[review] =
      name === "caught"
        ? { review: "an integer OVERFLOW", result: result("needs-work", 180000) }
        : name === "missed"
          ? { review: "nothing", result: result("needs-work", 120000) }
          : name === "cleandefect"
            ? { review: "no problems", result: result("clean", 240000) }
            : name === "control"
              ? { review: "needs rework", result: result("needs-work", 60000) }
              : { review: "broken", result: result(undefined, 300000) };
  }
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8"));
  assert.equal(record.casesFile, path.resolve(cases));
  assert.equal(record.repo, repo);
  assert.equal(record.startedAt, new Date(CLOCK).toISOString());
  const entry = record.configs.a;
  assert.equal(entry.harness, "pi");
  assert.deepEqual(entry.summary.defectCasesCaught, { caught: 1, total: 4, share: 0.25 });
  assert.deepEqual(entry.summary.defectsFound, { found: 1, total: 4 });
  assert.deepEqual(entry.summary.verdicts, { "needs-work": 3, clean: 1, invalid: 1 });
  assert.equal(entry.summary.falseAlarms, 1);
  assert.equal(entry.summary.invalidReviews, 1);
  assert.equal(entry.summary.medianMinutes, 3);
  assert.deepEqual(entry.summary.tokens, { prompt: 5000, cached: 2500, output: 1000 });
  assert.equal(entry.rows.length, 5);
  const caught = entry.rows.find((x) => x.case === "caught");
  assert.equal(caught.minutes, 3);
  assert.equal(caught.expect, "needs-work");
  assert.equal(caught.ran, true);
  assert.ok(fs.existsSync(caught.reviewFile));
  assert.match(r.stdout, /defect cases caught\s+1 of 4 \(25\.0%\)/);
  assert.match(r.stdout, /median minutes\s+3\.0/);
});

test("repeats: one row per repeat in numbered run directories", async () => {
  const cases = writeCases(path.join(tmp, "cases-rep.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-rep");
  const resp = {
    [path.join(out, "c1", "a", "1", "review.md")]: { review: "an OVERFLOW here", result: result("needs-work", 180000) },
    [path.join(out, "c1", "a", "2", "review.md")]: { review: "an OVERFLOW again", result: result("needs-work", 60000) },
  };
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--repeat", "2", "--out", out], { spawn });
  assert.equal(r.code, 0);
  assert.equal(spawn.launches.length, 2);
  const record = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8"));
  assert.deepEqual(record.configs.a.rows.map((x) => x.repeat), [1, 2]);
  assert.deepEqual(record.configs.a.rows.map((x) => x.caught), [true, true]);
  assert.equal(record.configs.a.summary.casesRun, 2);
  assert.deepEqual(record.configs.a.summary.defectCasesCaught, { caught: 2, total: 2, share: 1 });
});

test("a dispatch that failed to run is reported and fails the exit code", async () => {
  const cases = writeCases(path.join(tmp, "cases-fail.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-fail");
  const spawn = makeSpawn({ [path.join(out, "c1", "a", "1", "review.md")]: { code: 1, stderr: "boom" } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 1);
  const row = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a.rows[0];
  assert.equal(row.ran, false);
  assert.match(row.error, /boom/);
  assert.equal(row.verdict, "invalid");
  assert.equal(row.caught, false);
});

test("a busy engine stops the bench with a --force hint unless forced", async () => {
  const cases = writeCases(path.join(tmp, "cases-busy.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [] },
  ]);
  const spawn = makeSpawn({});
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", path.join(tmp, "out-busy")], { spawn, busy: true });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /use --force/);
  assert.equal(spawn.launches.length, 0);
});

test("--force skips the engine check", async () => {
  const cases = writeCases(path.join(tmp, "cases-force.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [] },
  ]);
  const out = path.join(tmp, "out-force");
  const spawn = makeSpawn({ [path.join(out, "c1", "a", "1", "review.md")]: { review: "fine", result: result("clean", 10000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--force", "--out", out], { spawn, fetchThrows: true });
  assert.equal(r.code, 0);
  assert.equal(spawn.launches.length, 1);
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
