/**
 * Behaviour tests for the recipe-gate mutate subcommand. Run by `nix flake
 * check`; they drive the CLI as a child process, the way a workflow gate does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-gate.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-mutate-"));
let counter = 0;

const gate = (...args) => {
  const r = spawnSync(process.execPath, [script, "mutate", ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.status} ${r.stderr}`);
  return r.stdout.trim();
};

const sleep = (ms) => spawnSync("sleep", [String(ms / 1000)]);

function markerAlive(marker) {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {}
    if (cmd.includes(marker)) return true;
  }
  return false;
}

// A tiny ESM calculator shaped like smoke/fixtures/tinycalc; the whole check is
// `node --test`. The change commit adds `base` (tested) and `unused` (not
// tested), so every changed line's fate is known in advance: line 6 is covered,
// line 10 is not, and deleting a `}` line unbalances the braces.
const calcBase = `export function add(a, b) {
  return a + b;
}
`;
const calcChange = `export function add(a, b) {
  return a + b;
}

export function base() {
  return 10;
}

export function unused() {
  return 42;
}
`;
const calcTest = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, base } from "./calc.js";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("base", () => {
  assert.equal(base(), 10);
});
`;

// A temp git repo at the base commit; returns the repo dir and the base sha.
function calcRepo() {
  const d = path.join(tmp, `repo${counter++}`);
  fs.mkdirSync(d);
  git(d, "init", "-b", "main");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "test");
  fs.writeFileSync(path.join(d, "package.json"), '{\n  "name": "mutcalc",\n  "version": "0.1.0",\n  "type": "module"\n}\n');
  fs.writeFileSync(path.join(d, "README.md"), "# mutcalc\n");
  fs.writeFileSync(path.join(d, "calc.js"), calcBase);
  fs.writeFileSync(path.join(d, "calc.test.js"), calcTest);
  git(d, "add", ".");
  git(d, "commit", "-m", "base");
  return { d, base: git(d, "rev-parse", "HEAD") };
}

const changeCommit = (d) => {
  fs.writeFileSync(path.join(d, "calc.js"), calcChange);
  git(d, "commit", "-am", "change");
};

// A surviving mutation: the uncovered line survives, the covered one is caught,
// the brace-breaking deletions are discarded, and the worktree comes back clean.
{
  const { d, base } = calcRepo();
  changeCommit(d);
  const r = gate(d, "--check", "node --test", "--base", base);
  assert.equal(r.status, 0, r.stderr);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.equal(j.reason, "");
  assert.deepEqual(j.files, ["calc.js"]);
  assert.equal(j.stopped, "exhausted");
  assert.equal(j.restored, true);
  assert.equal(j.tried, 10);
  assert.equal(j.caught, 3);
  assert.equal(j.discarded, 4);
  assert.equal(j.tried, j.caught + j.discarded + j.survivors.length);
  assert.ok(j.caught >= 1);
  assert.ok(!j.survivors.some((s) => s.from === "  return 10;"));
  assert.deepEqual(j.survivors, [
    {
      file: "calc.js",
      line: 10,
      from: "  return 42;",
      to: "  return 43;",
      diff: "--- a/calc.js\n+++ b/calc.js\n@@ -10 +10 @@\n-  return 42;\n+  return 43;\n",
    },
    {
      file: "calc.js",
      line: 10,
      from: "  return 42;",
      to: "  return 41;",
      diff: "--- a/calc.js\n+++ b/calc.js\n@@ -10 +10 @@\n-  return 42;\n+  return 41;\n",
    },
    {
      file: "calc.js",
      line: 10,
      from: "  return 42;",
      to: "",
      diff: "--- a/calc.js\n+++ b/calc.js\n@@ -10 +9,0 @@\n-  return 42;\n",
    },
  ]);
  for (const s of j.survivors) {
    assert.ok(s.diff.includes(`-${s.from}`));
    if (s.to !== "") assert.ok(s.diff.includes(`+${s.to}`));
    const a = spawnSync("git", ["apply", "--check", "--unidiff-zero", "-"], { cwd: d, input: s.diff, encoding: "utf8" });
    assert.equal(a.status, 0, a.stderr);
  }
  assert.ok(j.survivors.some((s) => s.to === ""));
  assert.equal(git(d, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(d, "calc.js"), "utf8"), calcChange);
}

// The bounds: --max stops by count, a spent budget stops by time.
{
  const { d, base } = calcRepo();
  changeCommit(d);
  const r = gate(d, "--check", "node --test", "--base", base, "--max", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.stopped, "max");
  assert.ok(r.json.tried <= 2);
  assert.equal(r.json.tried, r.json.caught + r.json.discarded + r.json.survivors.length);
  assert.equal(r.json.restored, true);
}
{
  const { d, base } = calcRepo();
  changeCommit(d);
  const r = gate(d, "--check", "node --test", "--base", base, "--ms", "10");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.stopped, "time");
  assert.ok(r.json.tried < 10);
  assert.equal(r.json.tried, r.json.caught + r.json.discarded + r.json.survivors.length);
  assert.equal(r.json.restored, true);
}

// A hanging check: the check spawns a sleeper with a unique process title and
// never finishes; the run stops on the budget and the sleeper is left dead.
{
  const { d, base } = calcRepo();
  changeCommit(d);
  const marker = `mutate-sleeper-${process.pid}-${Date.now()}`;
  const check = `node --title ${marker} -e 'setInterval(() => {})' & wait`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, "mutate", d, "--check", check, "--base", base, "--ms", "8000"], {
    encoding: "utf8",
    timeout: 60000,
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.stopped, "time");
  assert.ok(j.tried >= 1);
  assert.equal(j.restored, true);
  assert.ok(elapsed <= 8000 + 5000 + 5000, `took ${elapsed}ms`);
  assert.equal(git(d, "status", "--porcelain"), "");
  sleep(500);
  assert.ok(!markerAlive(marker));
}

// No changed .js/.mjs code: non-js changes and comment-only lines yield no
// candidate, so the run is a clean no-op.
{
  const { d, base } = calcRepo();
  fs.writeFileSync(path.join(d, "calc.js"), calcBase + "// note\n");
  fs.writeFileSync(path.join(d, "README.md"), "# mutcalc\n\na change\n");
  git(d, "commit", "-am", "change");
  const r = gate(d, "--check", "node --test", "--base", base);
  assert.equal(r.status, 0, r.stderr);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.deepEqual(j.files, ["calc.js"]);
  assert.equal(j.tried, 0);
  assert.equal(j.caught, 0);
  assert.equal(j.discarded, 0);
  assert.deepEqual(j.survivors, []);
  assert.equal(j.stopped, "exhausted");
  assert.equal(j.restored, true);
}

// Usage errors exit 2 with no JSON.
{
  const { d, base } = calcRepo();
  changeCommit(d);
  assert.equal(gate(d, "--base", base).status, 2);
  assert.equal(gate(d, "--check", "node --test", "--base", base, "--max", "abc").status, 2);
}
