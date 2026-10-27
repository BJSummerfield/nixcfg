import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
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

function writeCases(file, cases, repoDir = repo) {
  const withOwns = repoDir === repo ? cases.map((c) => ({ owns: ["x"], ...c })) : cases;
  fs.writeFileSync(file, JSON.stringify({ repo: repoDir, cases: withOwns }, null, 2));
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

test("the brief is the shared review brief with the task in its own file", async () => {
  const cases = writeCases(path.join(tmp, "cases-brief.json"), [
    { name: "c1", base: "v1", head: "v2", task: "make tinycalc parse negative numbers", check: "node test.mjs", expect: "needs-work", defects: [] },
  ]);
  const out = path.join(tmp, "out-brief");
  const runDir = path.join(out, "c1", "a", "1");
  const spawn = makeSpawn({ [path.join(runDir, "review.md")]: { review: "r", result: result("clean", 60000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
  assert.ok(brief.includes("Review a diff on a branch (the diff variant)."));
  assert.ok(brief.includes(`Task file: ${path.join(runDir, "task.md")}`));
  assert.equal(fs.readFileSync(path.join(runDir, "task.md"), "utf8"), "make tinycalc parse negative numbers");
  assert.ok(brief.includes("Diff to review: git diff v1..v2"));
  assert.ok(brief.includes("Owned files: x"));
  assert.ok(brief.includes("Check to run: node test.mjs"));
  assert.ok(brief.includes(`Write the report to ${path.join(runDir, "review.md")}`));
});

test("a case without owns takes them from the diff", async () => {
  const gitRepo = path.join(tmp, "git-repo");
  fs.mkdirSync(gitRepo);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: gitRepo });
  git("init", "-q");
  fs.writeFileSync(path.join(gitRepo, "kept.txt"), "1");
  fs.writeFileSync(path.join(gitRepo, "changed.txt"), "1");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  git("tag", "v1");
  fs.writeFileSync(path.join(gitRepo, "changed.txt"), "2");
  git("commit", "-q", "-am", "two");
  git("tag", "v2");
  const cases = writeCases(
    path.join(tmp, "cases-diffowns.json"),
    [{ name: "c1", base: "v1", head: "v2", task: "t", check: "c", expect: "clean", defects: [] }],
    gitRepo,
  );
  const out = path.join(tmp, "out-diffowns");
  const runDir = path.join(out, "c1", "a", "1");
  const spawn = makeSpawn({ [path.join(runDir, "review.md")]: { review: "r", result: result("clean", 60000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const brief = fs.readFileSync(path.join(runDir, "brief.md"), "utf8");
  assert.ok(brief.includes("Owned files: changed.txt\n"));
});

test("a case with an empty owns list exits 2 without dispatching", async () => {
  const cases = writeCases(path.join(tmp, "cases-emptyowns.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "clean", defects: [], owns: [] },
  ]);
  const spawn = makeSpawn({});
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", path.join(tmp, "out-emptyowns")], { spawn });
  assert.equal(r.code, 2);
  assert.equal(spawn.launches.length, 0);
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
  assert.deepEqual(rows.caught.defects, [{ id: "d1", found: true, named_in: "other" }]);
  assert.equal(rows.caught.caught, true);
  assert.equal(rows.caught.verdict, "needs-work");
  assert.deepEqual(rows.missed.defects, [{ id: "d1", found: false, named_in: "none" }]);
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
  assert.deepEqual(entry.rows[0].defects, [{ id: "d1", found: true, named_in: "other" }]);
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

test("scoring: named_in follows the section that names the defect", async () => {
  const cases = writeCases(path.join(tmp, "cases-named.json"), [
    { name: "inblocking", base: "a", head: "b", task: "t1", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "insmall", base: "a", head: "b", task: "t2", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "inother", base: "a", head: "b", task: "t3", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "namednowhere", base: "a", head: "b", task: "t4", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "both", base: "a", head: "b", task: "t5", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-named");
  const resp = {};
  const reviews = {
    inblocking: "## Blocking findings\n\nan integer OVERFLOW in parse\n",
    insmall: "## Small findings\n\nan integer OVERFLOW in parse\n",
    inother: "## Notes\n\nan integer OVERFLOW in parse\n",
    namednowhere: "looks fine\n",
    both: "## Blocking findings\n\nan OVERFLOW in parse\n\n## Small findings\n\nalso an OVERFLOW\n",
  };
  for (const [name, review] of Object.entries(reviews)) {
    resp[path.join(out, name, "a", "1", "review.md")] = { review, result: result("needs-work", 120000) };
  }
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn });
  assert.equal(r.code, 0);
  const entry = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a;
  const byCase = Object.fromEntries(entry.rows.map((x) => [x.case, x.defects[0]]));
  assert.equal(byCase.inblocking.named_in, "blocking");
  assert.equal(byCase.insmall.named_in, "small");
  assert.equal(byCase.inother.named_in, "other");
  assert.equal(byCase.namednowhere.named_in, "none");
  assert.equal(byCase.both.named_in, "blocking", "a defect named in both sections is blocking");
  assert.equal(byCase.inblocking.found, true);
  assert.equal(byCase.namednowhere.found, false);
  assert.equal(entry.summary.named_blocking, 2);
  assert.equal(entry.summary.named_small_only, 1);
  assert.equal(entry.summary.not_named, 1);
});

test("repeats: per-case and per-config caught counts with min/max defects found", async () => {
  const cases = writeCases(path.join(tmp, "cases-rep2.json"), [
    { name: "c1", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
    { name: "c2", base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] },
  ]);
  const out = path.join(tmp, "out-rep2");
  const resp = {
    [path.join(out, "c1", "a", "1", "review.md")]: { review: "an OVERFLOW here", result: result("needs-work", 180000) },
    [path.join(out, "c1", "a", "2", "review.md")]: { review: "nothing here", result: result("needs-work", 60000) },
    [path.join(out, "c2", "a", "1", "review.md")]: { review: "an OVERFLOW here", result: result("needs-work", 180000) },
    [path.join(out, "c2", "a", "2", "review.md")]: { review: "an OVERFLOW here", result: result("clean", 60000) },
  };
  const spawn = makeSpawn(resp);
  const r = await bench([cases, "--config", `a=${cfgA}`, "--repeat", "2", "--out", out], { spawn });
  assert.equal(r.code, 0);
  const entry = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a;
  assert.deepEqual(entry.summary.repeats, {
    caught: 2,
    total: 4,
    defectsFound: { min: 0, max: 1 },
    perCase: {
      c1: { caught: 1, total: 2, defectsFound: { min: 0, max: 1 } },
      c2: { caught: 1, total: 2, defectsFound: { min: 1, max: 1 } },
    },
  });
  assert.match(r.stdout, /repeats caught\s+2 of 4/);
  assert.match(r.stdout, /defects found range\s+0-1/);
  assert.match(r.stdout, /c1\s+1 of 2\s+0-1/);
  assert.match(r.stdout, /c2\s+1 of 2\s+1-1/);
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

const oneDefect = (name) => ({ name, base: "a", head: "b", task: "t", check: "c", expect: "needs-work", defects: [{ id: "d1", match: ["overflow"] }] });

test("scoring: a deeper heading inherits the section of its enclosing heading", async () => {
  const names = ["nested", "smallsub", "reset", "sibling", "topsmall"];
  const cases = writeCases(path.join(tmp, "cases-nested.json"), names.map(oneDefect));
  const out = path.join(tmp, "out-nested");
  const reviews = {
    nested: "# Review\n\n## Blocking findings\n\n### B1. Some title\n\nan OVERFLOW\n",
    smallsub: "## Blocking findings\n\nnothing here\n\n### S1 (small)\n\nan OVERFLOW\n",
    reset: "## Blocking findings\n\nnothing\n\n## Notes\n\nan OVERFLOW\n",
    sibling: "## Blocking findings\n\n### B1. x\n\nnothing\n\n### B2. y\n\nan OVERFLOW\n\n## Notes\n\n### N1\n\nstill fine\n",
    topsmall: "## Small findings\n\n### S1. title\n\nan OVERFLOW\n\n## Blocking findings\n\n### B1. title\n\nnothing\n",
  };
  const resp = {};
  for (const n of names) resp[path.join(out, n, "a", "1", "review.md")] = { review: reviews[n], result: result("needs-work", 60000) };
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn: makeSpawn(resp) });
  assert.equal(r.code, 0);
  const rows = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a.rows;
  const byCase = Object.fromEntries(rows.map((x) => [x.case, x.defects[0].named_in]));
  assert.deepEqual(byCase, { nested: "blocking", smallsub: "small", reset: "other", sibling: "blocking", topsmall: "small" });
});

test("resume: a repeat with a saved result is scored without dispatching; --rerun dispatches again", async () => {
  const cases = writeCases(path.join(tmp, "cases-resume.json"), [oneDefect("c1"), oneDefect("c2")]);
  const out = path.join(tmp, "out-resume");
  const review = (n) => path.join(out, n, "a", "1", "review.md");
  const first = makeSpawn({ [review("c1")]: { review: "an OVERFLOW", result: result("needs-work", 60000) } });
  fs.mkdirSync(path.dirname(review("c2")), { recursive: true });
  fs.writeFileSync(review("c2"), "nope");
  fs.writeFileSync(path.join(path.dirname(review("c2")), "result.json"), JSON.stringify(result("clean", 60000)));
  const r1 = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn: first });
  assert.equal(r1.code, 0);
  assert.equal(first.launches.length, 1, "only the repeat without a result is dispatched");
  const rows = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a.rows;
  assert.deepEqual(rows.map((x) => [x.case, x.verdict, x.ran]), [["c1", "needs-work", true], ["c2", "clean", true]]);

  const r2 = await bench([cases, "--config", `a=${cfgA}`, "--out", out], { spawn: makeSpawn({}) });
  assert.equal(r2.code, 0, "nothing to dispatch");

  const again = makeSpawn({
    [review("c1")]: { review: "an OVERFLOW", result: result("clean", 60000) },
    [review("c2")]: { review: "an OVERFLOW", result: result("clean", 60000) },
  });
  const r3 = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--rerun"], { spawn: again });
  assert.equal(r3.code, 0);
  assert.equal(again.launches.length, 2);
});

test("--rescore dispatches nothing, skips the engine check and reports missing results as not run", async () => {
  const cases = writeCases(path.join(tmp, "cases-rescore.json"), [oneDefect("c1"), oneDefect("c2"), oneDefect("c3")]);
  const out = path.join(tmp, "out-rescore");
  const dir = (n, rep) => path.join(out, n, "a", String(rep));
  fs.mkdirSync(dir("c1", 1), { recursive: true });
  fs.writeFileSync(path.join(dir("c1", 1), "review.md"), "## Blocking findings\n\n### B1. t\n\nan OVERFLOW\n");
  fs.writeFileSync(path.join(dir("c1", 1), "result.json"), JSON.stringify(result("needs-work", 60000)));
  fs.mkdirSync(dir("c2", 1), { recursive: true });
  const spawn = makeSpawn({});
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--rescore"], { spawn, fetchThrows: true });
  assert.equal(r.code, 0);
  assert.equal(spawn.launches.length, 0);
  assert.match(r.stdout, /c2 1: not run/);
  const entry = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a;
  assert.equal(entry.summary.named_blocking, 1);
  assert.equal(entry.rows.length, 1);
  assert.deepEqual(entry.notRun, [{ case: "c2", repeat: 1 }]);
  assert.ok(!fs.existsSync(dir("c3", 1)), "no directory is created for a repeat that never existed");
});

test("--timeout-ms replaces the dispatch timeout and must be a positive integer", async () => {
  const cases = writeCases(path.join(tmp, "cases-timeout.json"), [oneDefect("c1")]);
  const out = path.join(tmp, "out-timeout");
  const spawn = makeSpawn({ [path.join(out, "c1", "a", "1", "review.md")]: { review: "x", result: result("clean", 1000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--timeout-ms", "5000"], { spawn });
  assert.equal(r.code, 0);
  assert.equal(valueAt(spawn.launches[0].args, "--timeout-ms"), "5000");
  const bad = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--timeout-ms", "0"], { spawn: makeSpawn({}) });
  assert.equal(bad.code, 2);
});

test("--grades overrides the regex result and marks graded defects", async () => {
  const cases = writeCases(path.join(tmp, "cases-grades.json"), [
    { ...oneDefect("c1"), defects: [{ id: "d1", match: ["overflow"] }, { id: "d2", match: ["leak"] }] },
  ]);
  const out = path.join(tmp, "out-grades");
  const gradesFile = path.join(tmp, "grades.json");
  fs.writeFileSync(gradesFile, JSON.stringify({ "c1/a/1": { d1: "none", d2: "blocking" } }));
  const spawn = makeSpawn({ [path.join(out, "c1", "a", "1", "review.md")]: { review: "an OVERFLOW", result: result("needs-work", 1000) } });
  const r = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--grades", gradesFile], { spawn });
  assert.equal(r.code, 0);
  const entry = JSON.parse(fs.readFileSync(path.join(out, "bench.json"), "utf8")).configs.a;
  assert.deepEqual(entry.rows[0].defects, [
    { id: "d1", found: false, named_in: "none", graded: true },
    { id: "d2", found: true, named_in: "blocking", graded: true },
  ]);
  assert.equal(entry.summary.named_blocking, 1);
  assert.match(r.stdout, /graded by hand/);
  fs.writeFileSync(gradesFile, JSON.stringify({ "c1/a/1": { d1: "maybe" } }));
  const bad = await bench([cases, "--config", `a=${cfgA}`, "--out", out, "--grades", gradesFile], { spawn: makeSpawn({}) });
  assert.equal(bad.code, 2);
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
