/**
 * Final-check handling of recipe-gate: the plan gate's final_checks, the
 * integrate gate's --final flag and the repro timeout. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-gate.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-gate-final-"));
let counter = 0;

const dir = () => {
  const d = path.join(tmp, `d${counter++}`);
  fs.mkdirSync(d);
  return d;
};
const gate = (args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

const repo = dir();
const sizing = path.join(tmp, "sizing.json");
fs.writeFileSync(sizing, JSON.stringify({ implementer: { base: 1, k_read: 1, growth_p90: 1 } }));

const planDir = (section) => {
  const d = dir();
  fs.mkdirSync(path.join(d, "tasks"));
  fs.writeFileSync(path.join(d, "tasks", "a.md"), "id: a\nowns: new.txt\nreads: none\ncheck: true\ndepends: none\n\nBody.\n");
  if (section !== null) fs.writeFileSync(path.join(d, "plan.md"), `# Plan\n\n## Approach\nx\n\n${section}## Risks\nNone.\n`);
  return d;
};
const plan = (section) => gate(["plan", planDir(section), "--repo", repo, "--sizing", sizing, "--limit", "1000000"]).json;
const needs = "plan.md: ## Final checks needs one command per line, or none";

{
  const r = plan("## Final checks\n- `nix flake check`\n* make test\n\nplain cmd --flag\n");
  assert.equal(r.ok, true);
  assert.deepEqual(r.final_checks, ["nix flake check", "make test", "plain cmd --flag"]);
}
for (const none of ["none", "None.", "- none"]) {
  const r = plan(`## Final checks\n${none}\n\n`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.final_checks, []);
}
for (const section of ["", "## Final checks\n\n"]) {
  const r = plan(section);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [needs]);
  assert.deepEqual(r.final_checks, []);
}
{
  const r = plan(null);
  assert.deepEqual(r.missing, ["plan.md"]);
  assert.deepEqual(r.final_checks, []);
}

const integrate = (...flag) => gate(["integrate", dir(), "--tasks", "", ...flag]).json;
{
  assert.equal(integrate("--final", "pass").final_check, "pass");
  assert.equal(integrate("--final", "none").final_check, "none");
  const red = integrate("--final", "fail: red");
  assert.equal(red.final_check, "fail: red");
  assert.ok(red.reasons.includes("final checks: fail: red"));
  const absent = integrate();
  assert.equal(absent.final_check, "not recorded");
  assert.ok(absent.reasons.includes("final checks: not recorded"));
  assert.equal(integrate("--final", "banana").final_check, "not recorded");
  assert.ok(!("heavy_check" in absent));
}

{
  const repro = (ms) => gate(["repro", dir(), "--command", "sleep 2", "--expect", "pass", "--timeout-ms", ms]);
  const slow = repro("500");
  assert.equal(slow.json.ok, false);
  assert.equal(slow.json.timed_out, true);
  assert.equal(repro("5000").json.ok, true);
  assert.equal(gate(["repro", dir(), "--command", "true", "--timeout-ms", "0"]).status, 2);
}
