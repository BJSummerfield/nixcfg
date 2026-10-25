import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_TAG } from "./fixtures/tinycalc/calc.js";
import {
  HANDOFF_RESERVE,
  HANDOFF_TOKENS,
  TESTS,
  checkDispatch,
  checkDispatchModel,
  checkHandoff,
  checkImplement,
  checkMerged,
  checkResearch,
  checkStop,
  nodeTestOnBranch,
  settledAgain,
  spawnModel,
  statsFromRecords,
  stopReady,
} from "./tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-tests-"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Recorded sample of the runner config; the tests must not depend on the host's.
const RUNNER_CONFIG = {
  model: "redtruck/Qwen3.8-27B-NVFP4",
  stateDir: "/var/tmp/recipe-runner",
  worktreeDir: "/var/tmp/pi-worktrees",
  concurrency: 3,
  roles: {
    scout: { claude: { model: "sonnet" } },
    implementer: { budget: { tokens: 24000, reserve: 8000, action: "commit" } },
  },
};

test("TESTS holds the six live tests in order, each with a run function", () => {
  assert.deepEqual(TESTS.map((t) => t.name), ["dispatch-pi", "research", "implement", "handoff", "stop-resume", "dispatch-claude"]);
  for (const t of TESTS) assert.equal(typeof t.run, "function", t.name);
});

test("the handoff budget constants are 6000 tokens and 6000 reserve", () => {
  assert.equal(HANDOFF_TOKENS, 6000);
  assert.equal(HANDOFF_RESERVE, 6000);
});

test("the fixture carries a tag the child cannot guess", () => {
  assert.equal(FIXTURE_TAG, "tinycalc-q7v2");
});

const USAGE = { prompt: 1200, cached: 100, output: 80, turns: 2 };
const TAGGED_OUTPUT = `The exported constant FIXTURE_TAG has the value ${FIXTURE_TAG}.\n`;

test("checkDispatch passes a plausible result and fails each other way", () => {
  assert.deepEqual(checkDispatch({ ok: true, usage: USAGE }, TAGGED_OUTPUT, FIXTURE_TAG), { pass: true, detail: "" });
  assert.equal(checkDispatch(null, "add").pass, false);
  assert.match(checkDispatch(null, "add").detail, /no dispatch result file/);
  assert.equal(checkDispatch({ ok: false, error: "engine is down" }, "add").pass, false);
  assert.match(checkDispatch({ ok: false, error: "engine is down" }, "add").detail, /not ok: engine is down/);
  assert.equal(checkDispatch({ ok: true, usage: { prompt: 0, output: 0 } }, "add").pass, false);
  assert.match(checkDispatch({ ok: true, usage: { prompt: 0, output: 0 } }, "add").detail, /prompt 0/);
  assert.equal(checkDispatch({ ok: true, usage: { ...USAGE, turns: 1 } }, TAGGED_OUTPUT, FIXTURE_TAG).pass, false);
  assert.match(checkDispatch({ ok: true, usage: { ...USAGE, turns: 1 } }, TAGGED_OUTPUT, FIXTURE_TAG).detail, /round trip/);
  assert.equal(checkDispatch({ ok: true, usage: USAGE }, null, FIXTURE_TAG).pass, false);
  assert.match(checkDispatch({ ok: true, usage: USAGE }, null, FIXTURE_TAG).detail, /not written/);
  assert.equal(checkDispatch({ ok: true, usage: USAGE }, "tinycalc-q7v1", FIXTURE_TAG).pass, false);
  assert.match(checkDispatch({ ok: true, usage: USAGE }, "tinycalc-q7v1", FIXTURE_TAG).detail, /fixture tag/);
});

test("checkDispatchModel matches the model the spawn log recorded", () => {
  assert.deepEqual(checkDispatchModel("sonnet", "sonnet"), { pass: true, detail: "" });
  assert.equal(checkDispatchModel(null, "sonnet").pass, false);
  assert.match(checkDispatchModel(null, "sonnet").detail, /no model/);
  assert.equal(checkDispatchModel("haiku", "sonnet").pass, false);
  assert.match(checkDispatchModel("haiku", "sonnet").detail, /haiku, not sonnet/);
});

test("spawnModel reads the --model argument out of a spawn.jsonl under the run dir", () => {
  const runDir = fs.mkdtempSync(path.join(tmp, "spawn-"));
  const child = path.join(runDir, "children", "r1");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(
    path.join(child, "spawn.jsonl"),
    `${JSON.stringify({
      at: "2026-10-25T09:00:00.000Z",
      command: "pi",
      argv: ["--mode", "json", "--no-skills", "--model", "redtruck/Qwen3.8-27B-NVFP4", "--session-dir", runDir, "--session-id", "r1"],
      cwd: "/repo",
      env: { RECIPE_ROLE: "scout" },
    })}\n`,
  );
  assert.equal(spawnModel(runDir), "redtruck/Qwen3.8-27B-NVFP4");
  assert.equal(spawnModel(path.join(runDir, "missing")), null);
});

const RESEARCH_OK = {
  output: "summary.md",
  sources: { ok: 3, failed: 0, over_cap: 0 },
  healed: [],
  decide: [],
  open: [],
  gap_round: false,
  children: 9,
};

test("checkResearch passes a clean receipt and names the failure otherwise", () => {
  assert.deepEqual(checkResearch(RESEARCH_OK, "tinycalc exports add, which sums two numbers."), { pass: true, detail: "" });
  assert.equal(checkResearch(null, "add").pass, false);
  assert.match(checkResearch(null, "add").detail, /no receipt/);
  assert.equal(checkResearch({ failed: "failed: boom" }, "add").pass, false);
  assert.match(checkResearch({ failed: "failed: boom" }, "add").detail, /run failed/);
  assert.equal(checkResearch({ ...RESEARCH_OK, open: ["extractor for src 2 failed twice and was dropped"] }, "add").pass, false);
  assert.match(checkResearch({ ...RESEARCH_OK, open: ["extractor for src 2 failed twice and was dropped"] }, "add").detail, /open line/);
  assert.equal(checkResearch({ ...RESEARCH_OK, output: null }, "add").pass, false);
  assert.match(checkResearch({ ...RESEARCH_OK, output: null }, "add").detail, /names no output/);
  assert.equal(checkResearch(RESEARCH_OK, null).pass, false);
  assert.match(checkResearch(RESEARCH_OK, null).detail, /does not exist/);
  assert.equal(checkResearch(RESEARCH_OK, "it only multiplies").pass, false);
  assert.match(checkResearch(RESEARCH_OK, "it only multiplies").detail, /does not mention add/);
});

const IMPLEMENT_OK = {
  base: "a111",
  branch: "implement/plan",
  merged: ["multiply", "power"],
  left: [],
  open: [],
  children: 8,
};

test("checkImplement passes a fully merged run and names the first gap", () => {
  assert.deepEqual(checkImplement(IMPLEMENT_OK, ["multiply", "power"], true), { pass: true, detail: "" });
  assert.equal(checkImplement(null, ["multiply"], true).pass, false);
  assert.match(checkImplement(null, ["multiply"], true).detail, /no receipt/);
  const notMerged = checkImplement({ ...IMPLEMENT_OK, merged: ["multiply"] }, ["multiply", "power"], true);
  assert.equal(notMerged.pass, false);
  assert.match(notMerged.detail, /tasks not merged: power/);
  const left = checkImplement({ ...IMPLEMENT_OK, left: [{ id: "power", kind: "set_aside", branch: "t/power" }] }, ["multiply", "power"], true);
  assert.equal(left.pass, false);
  assert.match(left.detail, /left is not empty: power/);
  const red = checkImplement(IMPLEMENT_OK, ["multiply", "power"], false);
  assert.equal(red.pass, false);
  assert.match(red.detail, /node --test/);
});

test("checkMerged fails a stopped or failed run before looking at the tasks", () => {
  assert.equal(checkMerged({ stopped: true, reason: "SIGTERM", interrupted: ["planner"] }, ["multiply"]).pass, false);
  assert.match(checkMerged({ stopped: true, reason: "SIGTERM", interrupted: ["planner"] }, ["multiply"]).detail, /stopped: SIGTERM/);
  assert.equal(checkMerged({ failed: "failed: boom" }, ["multiply"]).pass, false);
  assert.match(checkMerged({ failed: "failed: boom" }, ["multiply"]).detail, /run failed/);
  assert.deepEqual(checkMerged({ merged: ["multiply"] }, ["multiply"]), { pass: true, detail: "" });
});

const NO_HANDOFF = [
  { type: "start", key: "impl/multiply", runId: "r1", pid: 1 },
  { type: "settle", key: "impl/multiply", runId: "r1", result: { status: "done", usage: { prompt: 100, cached: 0, output: 10 } } },
];

const WITH_HANDOFF = [
  NO_HANDOFF[0],
  { type: "handoff", key: "impl/multiply", runId: "r1", as: "relay", by: "r2", at: "2026-10-25T09:01:00.000Z" },
  { type: "start", key: "impl/multiply", runId: "r2", resumes: "r1", pid: 2 },
  { type: "settle", key: "impl/multiply", runId: "r2", result: { status: "done", usage: { prompt: 50, cached: 90, output: 5 } } },
];

test("checkHandoff sees the relayed handoff and nothing else", () => {
  assert.deepEqual(checkHandoff(WITH_HANDOFF), { pass: true, detail: "" });
  assert.equal(checkHandoff(NO_HANDOFF).pass, false);
  assert.match(checkHandoff(NO_HANDOFF).detail, /no relayed handoff/);
  assert.equal(checkHandoff([]).pass, false);
  assert.equal(checkHandoff([{ ...WITH_HANDOFF[1], as: "implementer" }]).pass, false);
  assert.equal(checkHandoff([{ ...WITH_HANDOFF[1], as: undefined }]).pass, false);
});

test("checkStop wants a stopped receipt with a non-empty interrupted list", () => {
  assert.deepEqual(checkStop({ stopped: true, reason: "SIGTERM", interrupted: ["planner"], board: null }), { pass: true, detail: "" });
  assert.equal(checkStop(null).pass, false);
  assert.match(checkStop(null).detail, /no receipt/);
  assert.equal(checkStop({ failed: "failed: boom" }).pass, false);
  assert.match(checkStop({ failed: "failed: boom" }).detail, /failed: boom/);
  assert.equal(checkStop({ stopped: true, reason: "SIGTERM" }).pass, false);
  assert.match(checkStop({ stopped: true, reason: "SIGTERM" }).detail, /no interrupted/);
  assert.equal(checkStop({ stopped: true, reason: "SIGTERM", interrupted: [] }).pass, false);
  assert.match(checkStop({ stopped: true, reason: "SIGTERM", interrupted: [] }).detail, /no interrupted/);
});

const SETTLE_THEN_START = [
  { type: "start", key: "planner", runId: "a1" },
  { type: "settle", key: "planner", runId: "a1", result: { status: "done" } },
  { type: "start", key: "locator/1", runId: "a2" },
];

test("stopReady wants a settled node and a start after it without a settle", () => {
  assert.equal(stopReady([{ type: "start", key: "planner", runId: "a1" }]), false);
  assert.equal(
    stopReady([SETTLE_THEN_START[0], { type: "settle", key: "planner", runId: "a1", result: { status: "done" } }]),
    false,
  );
  assert.equal(stopReady(SETTLE_THEN_START), true);
  assert.equal(stopReady([...SETTLE_THEN_START, { type: "settle", key: "locator/1", runId: "a2", result: { status: "done" } }]), false);
});

const BEFORE_STOP = [
  { type: "start", key: "planner", runId: "a1" },
  { type: "settle", key: "planner", runId: "a1", result: { status: "done" } },
  { type: "start", key: "locator/1", runId: "a2" },
];

test("settledAgain flags a settled node restarted after the stop, not its own relay", () => {
  const clean = [
    ...BEFORE_STOP,
    { type: "start", key: "locator/1", runId: "b2", resumes: "a2" },
    { type: "settle", key: "locator/1", runId: "b2", result: { status: "done" } },
  ];
  assert.deepEqual(settledAgain(BEFORE_STOP, clean), []);
  const bad = [...clean, { type: "start", key: "planner", runId: "c1" }];
  assert.deepEqual(settledAgain(BEFORE_STOP, bad), ["planner"]);
  assert.deepEqual(settledAgain(BEFORE_STOP, BEFORE_STOP), []);
});

test("statsFromRecords counts started children and sums the settled usage", () => {
  assert.deepEqual(statsFromRecords(WITH_HANDOFF), { children: 2, usage: { prompt: 50, cached: 90, output: 5 } });
  assert.deepEqual(statsFromRecords([]), { children: 0, usage: { prompt: 0, cached: 0, output: 0 } });
  assert.deepEqual(statsFromRecords(null), statsFromRecords([]));
});

function fakeRunner(ok) {
  return async (args, opts) => {
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "dispatch") {
      const dir = value("--dir");
      const child = path.join(dir, "children", "r1");
      fs.mkdirSync(child, { recursive: true });
      const config = JSON.parse(fs.readFileSync(opts?.env?.RECIPE_RUNNER_CONFIG, "utf8"));
      fs.writeFileSync(
        path.join(child, "spawn.jsonl"),
        `${JSON.stringify({
          at: "2026-10-25T09:00:00.000Z",
          command: "pi",
          argv: ["--mode", "json", "--no-skills", "--model", config.model, "--session-dir", dir, "--session-id", "r1"],
          cwd: value("--cwd"),
          env: { RECIPE_ROLE: "scout" },
        })}\n`,
      );
    }
    if (ok) {
      fs.writeFileSync(value("--output"), `The exported constant FIXTURE_TAG has the value ${FIXTURE_TAG}.\n`);
      fs.writeFileSync(
        value("--result-file"),
        JSON.stringify({ ok: true, status: "done", runId: "r1", finalText: "", usage: { prompt: 1200, cached: 100, output: 80, turns: 2 } }),
      );
    } else {
      fs.writeFileSync(
        value("--result-file"),
        JSON.stringify({ ok: false, status: "failed", error: "engine is down", usage: { prompt: 0, cached: 0, output: 0, turns: 0 } }),
      );
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function fakeCtx(ok) {
  const workdir = fs.mkdtempSync(path.join(tmp, "dispatch-"));
  const configPath = path.join(workdir, "roles.json");
  fs.writeFileSync(configPath, JSON.stringify(RUNNER_CONFIG, null, 2));
  return {
    workdir,
    fixturesDir,
    full: false,
    env: { RECIPE_RUNNER_CONFIG: configPath },
    signal: undefined,
    track: () => {},
    runner: fakeRunner(ok),
  };
}

test("dispatch-pi passes against a fake runner that writes a plausible result", async () => {
  const t = TESTS.find((x) => x.name === "dispatch-pi");
  const r = await t.run(fakeCtx(true));
  assert.equal(r.name, "dispatch-pi");
  assert.equal(r.pass, true, r.detail);
  assert.equal(r.detail, "");
  assert.equal(r.children, 1);
  assert.deepEqual(r.usage, { prompt: 1200, cached: 100, output: 80 });
});

test("dispatch-pi fails with a detail when the result is not ok", async () => {
  const t = TESTS.find((x) => x.name === "dispatch-pi");
  const r = await t.run(fakeCtx(false));
  assert.equal(r.pass, false);
  assert.match(r.detail, /not ok: engine is down/);
});

function implRepo(base, calcJs, calcTestJs) {
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "smoke-test");
  git("config", "user.email", "smoke@test.invalid");
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "tinycalc", "type": "module" }\n`);
  fs.writeFileSync(path.join(dir, "calc.js"), calcJs);
  fs.writeFileSync(path.join(dir, "calc.test.js"), calcTestJs);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  git("branch", "implement/plan");
  return dir;
}

const MULTIFY_CALC = [
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "export function multiply(a, b) {",
  "  return a * b;",
  "}",
  "",
].join("\n");
const ADD_CALC = [
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
].join("\n");
const MULTIFY_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { multiply } from "./calc.js";',
  "",
  'test("multiply", () => {',
  "  assert.equal(multiply(4, 5), 20);",
  "});",
  "",
].join("\n");

test("nodeTestOnBranch passes a branch whose test passes and whose calc.js exports multiply", () => {
  const base = fs.mkdtempSync(path.join(tmp, "impl-"));
  const repo = implRepo(base, MULTIFY_CALC, MULTIFY_TEST);
  const r = nodeTestOnBranch(repo, "implement/plan", path.join(base, "integration"));
  assert.equal(r.passed, true, r.error);
});

test("nodeTestOnBranch fails a branch whose calc.js does not export multiply", () => {
  const base = fs.mkdtempSync(path.join(tmp, "impl-"));
  const repo = implRepo(base, ADD_CALC, "");
  const r = nodeTestOnBranch(repo, "implement/plan", path.join(base, "integration"));
  assert.equal(r.passed, false);
  assert.match(r.error, /does not export multiply/);
});

test("nodeTestOnBranch fails a branch whose node --test fails", () => {
  const base = fs.mkdtempSync(path.join(tmp, "impl-"));
  const repo = implRepo(base, ADD_CALC, MULTIFY_TEST);
  const r = nodeTestOnBranch(repo, "implement/plan", path.join(base, "integration"));
  assert.equal(r.passed, false);
  assert.match(r.error, /node --test failed/);
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
