import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeWorktree, removeWorktree, sweep, sweepFiles, worktreeState } from "./worktree.mjs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-worktree-"));
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

const repo = path.join(tmp, "proj");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git(repo, "add", "a.txt");
git(repo, "commit", "-q", "-m", "one");
git(repo, "branch", "side");

const root = path.join(tmp, "wt");
const one = makeWorktree({ repo, root, name: "r1" });
assert.equal(one.ok, true, one.reason);
assert.equal(one.worktree, path.join(root, "proj", "r1"));
assert.equal(one.branch, "recipe/r1");
assert.equal(one.head, git(repo, "rev-parse", "HEAD"));

const two = makeWorktree({ repo, root, name: "r2", base: "side" });
assert.equal(two.ok, true, two.reason);

assert.deepEqual(worktreeState(one.worktree, "main"), { exists: true, clean: true, commits: 0 });
fs.writeFileSync(path.join(one.worktree, "b.txt"), "b\n");
assert.equal(worktreeState(one.worktree, "main").clean, false);
git(one.worktree, "add", "b.txt");
git(one.worktree, "commit", "-q", "-m", "two");
assert.deepEqual(worktreeState(one.worktree, "main"), { exists: true, clean: true, commits: 1 });
assert.equal(worktreeState(path.join(root, "nope"), "main").exists, false);

const dup = makeWorktree({ repo, root, name: "r1" });
assert.equal(dup.ok, false);
assert.ok(dup.reason.length > 0);
assert.equal(makeWorktree({ repo, root, name: "r3", base: "no-such-ref" }).ok, false);

assert.deepEqual(removeWorktree(one.worktree), { ok: true, reason: null });
assert.equal(fs.existsSync(one.worktree), false);
assert.equal(git(repo, "branch", "--list", "recipe/r1"), "");

const swept = sweep(root, repo, { now: Date.now() + 21 * DAY_MS });
assert.deepEqual(swept, [two.worktree]);
assert.equal(fs.existsSync(two.worktree), false);
assert.notEqual(git(repo, "branch", "--list", "recipe/r2"), "");
assert.doesNotMatch(git(repo, "worktree", "list"), /r2/);
assert.deepEqual(sweep(root, repo), []);

const files = path.join(tmp, "files");
fs.mkdirSync(files);
const oldFile = path.join(files, "old.json");
const newFile = path.join(files, "new.json");
fs.writeFileSync(oldFile, "{}");
fs.writeFileSync(newFile, "{}");
const past = new Date(Date.now() - 30 * DAY_MS);
fs.utimesSync(oldFile, past, past);
assert.deepEqual(sweepFiles(files), [oldFile]);
assert.equal(fs.existsSync(newFile), true);
assert.deepEqual(sweepFiles(path.join(tmp, "missing")), []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("worktree ok");
