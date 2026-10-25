import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  engineLoad,
  formatTable,
  isBusy,
  makeWorkdir,
  metricsUrl,
  parseArgs,
  removeWorkdir,
  resultRecord,
  selectTests,
  setupPlan,
  setupRepo,
  withRoleOverrides,
} from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-core-"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("parseArgs reads every flag and defaults", () => {
  assert.deepEqual(parseArgs([]), { full: false, only: null, skipClaude: false, keep: false, force: false, out: null });
  assert.deepEqual(parseArgs(["--full", "--only", "a , b", "--skip-claude", "--keep", "--force", "--out", "o"]), {
    full: true,
    only: ["a", "b"],
    skipClaude: true,
    keep: true,
    force: true,
    out: "o",
  });
});

test("parseArgs rejects an unknown flag naming it", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown flag --nope/);
});

test("parseArgs rejects a value flag without its value", () => {
  assert.throws(() => parseArgs(["--only"]), /--only/);
  assert.throws(() => parseArgs(["--out"]), /--out/);
  assert.throws(() => parseArgs(["--only", ""]), /--only/);
});

test("selectTests keeps order, applies only and skipClaude, and rejects unknown names", () => {
  const names = ["impl/multiply", "impl/multiply-claude", "review"];
  assert.deepEqual(selectTests(names, { only: ["review", "impl/multiply"] }), ["impl/multiply", "review"]);
  assert.deepEqual(selectTests(names, { skipClaude: true }), ["impl/multiply", "review"]);
  assert.deepEqual(selectTests(names, { only: ["impl/multiply", "impl/multiply-claude"], skipClaude: true }), [
    "impl/multiply",
  ]);
  assert.throws(() => selectTests(names, { only: ["ghost"] }), /unknown test ghost/);
});

test("metricsUrl is the provider baseUrl origin plus /ops/metrics", () => {
  const models = { providers: { redtruck: { baseUrl: "https://host:8443/v1" }, other: { baseUrl: "http://a.b:1/" } } };
  assert.equal(metricsUrl(models, "redtruck"), "https://host:8443/ops/metrics");
  assert.equal(metricsUrl(models, "other"), "http://a.b:1/ops/metrics");
  assert.throws(() => metricsUrl(models, "ghost"), /ghost/);
  assert.throws(() => metricsUrl({ providers: { x: {} } }, "x"), /x/);
});

test("engineLoad reads the ninfer gauges, with and without labels", () => {
  const busy = [
    "# HELP ninfer_running sequences currently running",
    "# TYPE ninfer_running gauge",
    "ninfer_running 2",
    "# TYPE ninfer_waiting gauge",
    'ninfer_waiting{queue="default"} 1',
    'other_metric{a="b"} 9',
  ].join("\n");
  assert.deepEqual(engineLoad(busy), { running: 2, waiting: 1 });
  assert.equal(isBusy(engineLoad(busy)), true);
  assert.deepEqual(engineLoad("# TYPE ninfer_running gauge\nninfer_running 0\n"), { running: 0, waiting: 0 });
  assert.deepEqual(engineLoad("unrelated 1\n"), { running: 0, waiting: 0 });
  assert.equal(isBusy({ running: 0, waiting: 0 }), false);
  assert.equal(isBusy({ running: 0, waiting: 3 }), true);
});

test("makeWorkdir makes a fresh named directory and removeWorkdir honours keep", () => {
  const parent = path.join(tmp, "parent");
  const a = makeWorkdir(parent);
  assert.match(path.basename(a), /^recipe-smoke-\d+-[0-9a-f]{8}$/);
  assert.ok(fs.statSync(a).isDirectory());
  const b = makeWorkdir(parent);
  assert.notEqual(a, b);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });

  const c = makeWorkdir(parent);
  removeWorkdir(c, false);
  assert.equal(fs.existsSync(c), false);
  const d = makeWorkdir(parent);
  removeWorkdir(d, true);
  assert.ok(fs.existsSync(d));
  fs.rmSync(d, { recursive: true, force: true });
});

test("setupRepo makes a clean committed repo whose check passes", () => {
  const dest = path.join(tmp, "repo");
  const head = setupRepo(fixturesDir, dest);
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: dest, encoding: "utf8" }).stdout.trim(), head);
  assert.equal(spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dest, encoding: "utf8" }).stdout.trim(), "main");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" }).stdout.trim(), "");
  const run = spawnSync(process.execPath, ["--test"], { cwd: dest, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /pass/);
});

test("setupPlan copies the plan and both tasks", () => {
  const dest = path.join(tmp, "plan");
  assert.equal(setupPlan(fixturesDir, dest), dest);
  for (const f of ["plan.md", "tasks/multiply.md", "tasks/power.md"]) {
    assert.ok(fs.existsSync(path.join(dest, f)), f);
  }
});

test("setupRepo and setupPlan make read-only fixture copies writable", () => {
  const setModes = (root, fileMode, dirMode) => {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        fs.chmodSync(p, entry.isDirectory() ? dirMode : fileMode);
      }
    };
    walk(root);
  };
  const assertWritable = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const p = path.join(dir, entry.name);
      assert.ok(fs.statSync(p).mode & 0o200, `${p} is not owner-writable`);
      if (entry.isDirectory()) assertWritable(p);
    }
  };

  const fixtures = path.join(tmp, "readonly-fixtures");
  const tinycalc = path.join(fixtures, "tinycalc");
  fs.mkdirSync(path.join(tinycalc, "src"), { recursive: true });
  fs.writeFileSync(path.join(tinycalc, "package.json"), "{}\n");
  fs.writeFileSync(path.join(tinycalc, "src", "index.js"), "export const add = (a, b) => a + b;\n");
  const tinycalcPlan = path.join(fixtures, "tinycalc-plan");
  fs.mkdirSync(path.join(tinycalcPlan, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(tinycalcPlan, "plan.md"), "# plan\n");
  fs.writeFileSync(path.join(tinycalcPlan, "tasks", "one.md"), "task one\n");
  setModes(fixtures, 0o444, 0o555);

  const head = setupRepo(fixtures, path.join(tmp, "readonly-repo"));
  assert.match(head, /^[0-9a-f]{40}$/);
  assertWritable(path.join(tmp, "readonly-repo"));

  const plan = setupPlan(fixtures, path.join(tmp, "readonly-plan"));
  assertWritable(plan);
  assert.ok(fs.existsSync(path.join(plan, "tasks", "one.md")));

  // restore the write bits so the temporary directory can be removed
  setModes(fixtures, 0o644, 0o755);
});

test("withRoleOverrides deep-merges into roles without touching anything else", () => {
  const config = {
    concurrency: 3,
    roles: {
      implementer: { budget: { tokens: 40000, reserve: 8000, action: "commit" }, model: "local" },
      reviewer: { budget: { tokens: 50000, reserve: 9000, action: "stop" } },
    },
  };
  const before = JSON.stringify(config);
  const out = withRoleOverrides(config, { implementer: { budget: { tokens: 20000 } } });
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(out.roles.implementer, {
    budget: { tokens: 20000, reserve: 8000, action: "commit" },
    model: "local",
  });
  assert.deepEqual(out.roles.reviewer, config.roles.reviewer);
  assert.equal(out.concurrency, 3);

  const extended = withRoleOverrides(config, { scout: { budget: { tokens: 1000 } } });
  assert.deepEqual(extended.roles.scout, { budget: { tokens: 1000 } });
  assert.equal(extended.roles.implementer.budget.tokens, 40000);

  out.roles.implementer.budget.tokens = 1;
  out.roles.implementer.budget.reserve = 0;
  assert.equal(config.roles.implementer.budget.tokens, 40000);
});

test("formatTable renders pass, FAIL and skip rows with a totals row", () => {
  const results = [
    {
      name: "impl/multiply",
      pass: true,
      ms: 75400,
      children: 1,
      usage: { prompt: 1200, cached: 200, output: 300 },
      detail: "ok",
    },
    {
      name: "review",
      pass: false,
      ms: 610000,
      children: 0,
      usage: { prompt: 500, cached: 0, output: 700 },
      detail: "check failed:\nnode --test exited 1",
    },
    { name: "research", pass: null, ms: 0, children: 2, usage: null, detail: "engine busy" },
  ];
  const table = formatTable(results);
  const lines = table.split("\n");
  assert.deepEqual(lines[0].trim().split(/\s+/), ["test", "result", "time", "children", "prompt", "cached", "output", "detail"]);
  const row = (name) => lines.find((l) => l.startsWith(name));
  assert.match(row("impl/multiply"), /pass\s+1:15\s+1\s+1200\s+200\s+300/);
  assert.match(row("review"), /FAIL\s+10:10\s+0\s+500\s+0\s+700/);
  assert.match(row("research"), /skip\s+0:00/);
  const long = formatTable([
    {
      name: "x",
      pass: true,
      ms: 0,
      children: 0,
      usage: { prompt: 0, cached: 0, output: 0 },
      detail: "y".repeat(80),
    },
  ]);
  const detailRow = long.split("\n")[1];
  const detailCell = detailRow.slice(detailRow.indexOf("y"));
  assert.ok(detailCell.length <= 60, `detail cell is ${detailCell.length} chars`);
  const totals = lines.at(-1);
  assert.match(totals, /^totals\s+1p 1f 1s\s+11:25\s+3\s+1700\s+200\s+1000/);
  for (const line of lines) {
    assert.equal(line.length, lines[0].length, "fixed-width rows");
  }
});

test("resultRecord carries the meta and the results", () => {
  const results = [{ name: "a", pass: true, ms: 100, children: 0, usage: { prompt: 1, cached: 0, output: 1 }, detail: "" }];
  const record = resultRecord(results, {
    startedAt: "2026-10-25T08:00:00Z",
    finishedAt: "2026-10-25T08:10:00Z",
    host: "redtruck",
    full: false,
  });
  assert.deepEqual(record, {
    startedAt: "2026-10-25T08:00:00Z",
    finishedAt: "2026-10-25T08:10:00Z",
    host: "redtruck",
    full: false,
    results,
  });
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
