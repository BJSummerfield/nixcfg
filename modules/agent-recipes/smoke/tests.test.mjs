import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HANDOFF_RESERVE,
  HANDOFF_TOKENS,
  TESTS,
  checkDispatch,
  checkHandoff,
  checkImplement,
  checkMerged,
  checkResearch,
  checkStop,
  settledAgain,
  statsFromRecords,
} from "./tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-tests-"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("TESTS holds the six live tests in order, each with a run function", () => {
  assert.deepEqual(TESTS.map((t) => t.name), ["dispatch-pi", "research", "implement", "handoff", "stop-resume", "dispatch-claude"]);
  for (const t of TESTS) assert.equal(typeof t.run, "function", t.name);
});

test("the handoff budget constants start at 24000 and 8000", () => {
  assert.equal(HANDOFF_TOKENS, 24000);
  assert.equal(HANDOFF_RESERVE, 8000);
});

const USAGE = { prompt: 1200, cached: 100, output: 80 };

test("checkDispatch passes a plausible result and fails each other way", () => {
  assert.deepEqual(checkDispatch({ ok: true, usage: USAGE }, "tinycalc exports add."), { pass: true, detail: "" });
  assert.equal(checkDispatch(null, "add").pass, false);
  assert.match(checkDispatch(null, "add").detail, /no dispatch result file/);
  assert.equal(checkDispatch({ ok: false, error: "engine is down" }, "add").pass, false);
  assert.match(checkDispatch({ ok: false, error: "engine is down" }, "add").detail, /not ok: engine is down/);
  assert.equal(checkDispatch({ ok: true, usage: { prompt: 0, output: 0 } }, "add").pass, false);
  assert.match(checkDispatch({ ok: true, usage: { prompt: 0, output: 0 } }, "add").detail, /prompt 0/);
  assert.equal(checkDispatch({ ok: true, usage: USAGE }, null).pass, false);
  assert.match(checkDispatch({ ok: true, usage: USAGE }, null).detail, /not written/);
  assert.equal(checkDispatch({ ok: true, usage: USAGE }, "nothing here").pass, false);
  assert.match(checkDispatch({ ok: true, usage: USAGE }, "nothing here").detail, /does not name add/);
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
  { type: "handoff", key: "impl/multiply", runId: "r1", by: "r2", as: "implementer" },
  { type: "start", key: "impl/multiply", runId: "r2", resumes: "r1", pid: 2 },
  { type: "settle", key: "impl/multiply", runId: "r2", result: { status: "done", usage: { prompt: 50, cached: 90, output: 5 } } },
];

test("checkHandoff sees the relayed handoff and nothing else", () => {
  assert.deepEqual(checkHandoff(WITH_HANDOFF), { pass: true, detail: "" });
  assert.equal(checkHandoff(NO_HANDOFF).pass, false);
  assert.match(checkHandoff(NO_HANDOFF).detail, /no relayed handoff/);
  assert.equal(checkHandoff([]).pass, false);
});

test("checkStop wants a stopped receipt with an interrupted list", () => {
  assert.deepEqual(checkStop({ stopped: true, reason: "SIGTERM", interrupted: ["planner"], board: null }), { pass: true, detail: "" });
  assert.equal(checkStop(null).pass, false);
  assert.match(checkStop(null).detail, /no receipt/);
  assert.equal(checkStop({ failed: "failed: boom" }).pass, false);
  assert.match(checkStop({ failed: "failed: boom" }).detail, /failed: boom/);
  assert.equal(checkStop({ stopped: true, reason: "SIGTERM" }).pass, false);
  assert.match(checkStop({ stopped: true, reason: "SIGTERM" }).detail, /no interrupted/);
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
  return async (args) => {
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (ok) {
      fs.writeFileSync(value("--output"), "tinycalc exports exactly one function: add.\n");
      fs.writeFileSync(
        value("--result-file"),
        JSON.stringify({ ok: true, status: "done", runId: "r1", finalText: "", usage: { prompt: 1200, cached: 100, output: 80 } }),
      );
    } else {
      fs.writeFileSync(
        value("--result-file"),
        JSON.stringify({ ok: false, status: "failed", error: "engine is down", usage: { prompt: 0, cached: 0, output: 0 } }),
      );
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function fakeCtx(ok) {
  return {
    workdir: fs.mkdtempSync(path.join(tmp, "dispatch-")),
    fixturesDir,
    full: false,
    env: {},
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
