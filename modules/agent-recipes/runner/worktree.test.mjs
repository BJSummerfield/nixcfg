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
const unreadable = worktreeState(one.worktree, "no-such-ref");
assert.equal(unreadable.commits, null);
assert.equal(unreadable.exists, true);

assert.deepEqual(worktreeState(path.join(root, "nope"), "main"), { exists: false, clean: false, commits: 0 });
const notRepo = path.join(tmp, "plain");
fs.mkdirSync(notRepo);
assert.equal(worktreeState(notRepo, "main").clean, false);
assert.equal(makeWorktree({ repo, root }).ok, false);
assert.equal(makeWorktree({ repo, name: "r9" }).ok, false);

const dup = makeWorktree({ repo, root, name: "r1" });
assert.equal(dup.ok, false);
assert.ok(dup.reason.length > 0);
assert.equal(makeWorktree({ repo, root, name: "r3", base: "no-such-ref" }).ok, false);

assert.deepEqual(removeWorktree(one.worktree), { ok: true, reason: null });
assert.equal(fs.existsSync(one.worktree), false);
assert.equal(git(repo, "branch", "--list", "recipe/r1"), "");

const detached = path.join(root, "proj", "det");
git(repo, "worktree", "add", "-q", "--detach", detached, "main");
assert.deepEqual(removeWorktree(detached), { ok: true, reason: null });
assert.equal(fs.existsSync(detached), false);

const gone = makeWorktree({ repo, root, name: "gone" });
const other = makeWorktree({ repo, root, name: "other" });
fs.rmSync(gone.worktree, { recursive: true, force: true });
assert.match(git(repo, "worktree", "list"), /gone/);
assert.equal(removeWorktree(other.worktree).ok, true);
assert.doesNotMatch(git(repo, "worktree", "list"), /gone/);
git(repo, "branch", "-D", "recipe/gone");

const edge = makeWorktree({ repo, root, name: "edge" });
const edgeTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 40 * DAY_MS);
fs.utimesSync(edge.worktree, edgeTime, edgeTime);
const edgeMs = fs.statSync(edge.worktree).mtimeMs;
assert.deepEqual(sweep(root, repo, { now: edgeMs + 20 * DAY_MS }), []);
assert.equal(fs.existsSync(edge.worktree), true);
assert.deepEqual(sweep(root, repo, { now: edgeMs + 20 * DAY_MS + 1 }), [edge.worktree]);
git(repo, "branch", "-D", "recipe/edge");

const stale = makeWorktree({ repo, root, name: "stale" });
fs.rmSync(stale.worktree, { recursive: true, force: true });
assert.deepEqual(sweep(root, repo), []);
assert.match(git(repo, "worktree", "list"), /stale/);
git(repo, "worktree", "prune");
git(repo, "branch", "-D", "recipe/stale");

const swept = sweep(root, repo, { now: Date.now() + 21 * DAY_MS });
assert.deepEqual(swept, [two.worktree]);
assert.equal(fs.existsSync(two.worktree), false);
assert.notEqual(git(repo, "branch", "--list", "recipe/r2"), "");
assert.doesNotMatch(git(repo, "worktree", "list"), /r2/);
assert.deepEqual(sweep(root, repo), []);

const shimDir = path.join(tmp, "shim");
const shimLog = path.join(tmp, "git-calls.log");
fs.mkdirSync(shimDir);
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
fs.writeFileSync(path.join(shimDir, "git"), `#!/bin/sh\necho "$*" >> "${shimLog}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
const spied = makeWorktree({ repo, root, name: "spied" });
const savedPath = process.env.PATH;
process.env.PATH = `${shimDir}:${savedPath}`;
assert.deepEqual(sweep(root, repo, { now: Date.now() + 21 * DAY_MS }), [spied.worktree]);
process.env.PATH = savedPath;
assert.match(fs.readFileSync(shimLog, "utf8"), /worktree remove --force .*spied/);
git(repo, "branch", "-D", "recipe/spied");

const files = path.join(tmp, "files");
fs.mkdirSync(files);
const oldFile = path.join(files, "old.json");
const newFile = path.join(files, "new.json");
fs.writeFileSync(oldFile, "{}");
fs.writeFileSync(newFile, "{}");
const past = new Date(Date.now() - 30 * DAY_MS);
fs.utimesSync(oldFile, past, past);
const target = path.join(tmp, "target.json");
fs.writeFileSync(target, "{}");
fs.utimesSync(target, past, past);
const link = path.join(files, "link.json");
fs.symlinkSync(target, link);
assert.deepEqual(sweepFiles(files), [oldFile]);
assert.equal(fs.existsSync(target), true);
assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
assert.equal(fs.existsSync(newFile), true);
assert.deepEqual(sweepFiles(path.join(tmp, "missing")), []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("worktree ok");
