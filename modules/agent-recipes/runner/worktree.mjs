import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { where } from "../gates/recipe-git.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status ?? -1,
    out: (r.stdout ?? "").trim(),
    err: ((r.stderr ?? "") + (r.error ? String(r.error.message) : "")).trim(),
  };
}

function repoName(repo) {
  const top = where(repo).worktree;
  return top ? path.basename(top) : null;
}

export function makeWorktree({ repo, base = "HEAD", root, name }) {
  const fail = (reason) => ({ ok: false, reason, worktree: null, branch: null, head: null });
  const repoDir = repoName(repo);
  if (!repoDir) return fail(`not a git repository: ${repo}`);
  if (!root || !name) return fail("root and name are required");
  const worktree = path.join(root, repoDir, name);
  const branch = `recipe/${name}`;
  try {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
  } catch (e) {
    return fail(String(e.message));
  }
  const r = git(repo, ["worktree", "add", "-b", branch, worktree, base]);
  if (r.status !== 0) return fail(r.err || r.out || "git worktree add failed");
  return { ok: true, reason: null, worktree, branch, head: git(worktree, ["rev-parse", "HEAD"]).out };
}

export function worktreeState(worktree, base) {
  if (!fs.existsSync(worktree)) return { exists: false, clean: false, commits: 0 };
  const status = git(worktree, ["status", "--porcelain"]);
  const count = git(worktree, ["rev-list", "--count", `${base}..HEAD`]);
  return {
    exists: true,
    clean: status.status === 0 && status.out === "",
    commits: count.status === 0 ? Number(count.out) : null,
  };
}

export function removeWorktree(worktree, { deleteBranch = true } = {}) {
  const info = where(worktree);
  if (!info.worktree) return { ok: false, reason: `not a git worktree: ${worktree}` };
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0) return { ok: false, reason: common.err || "cannot find the main repository" };
  const main = path.dirname(common.out);
  const rm = git(main, ["worktree", "remove", "--force", worktree]);
  if (rm.status !== 0) return { ok: false, reason: rm.err || rm.out };
  git(main, ["worktree", "prune"]);
  if (deleteBranch && info.branch) {
    const del = git(main, ["branch", "-D", info.branch]);
    if (del.status !== 0) return { ok: false, reason: del.err || del.out };
  }
  return { ok: true, reason: null };
}

export function sweep(root, repo, { maxAgeDays = 20, now = Date.now() } = {}) {
  const repoDir = repoName(repo);
  if (!repoDir) return [];
  const dir = path.join(root, repoDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    const p = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs <= maxAgeDays * DAY_MS) continue;
    git(repo, ["worktree", "remove", "--force", p]);
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  if (removed.length) git(repo, ["worktree", "prune"]);
  return removed;
}

export function sweepFiles(dir, { maxAgeDays = 20, now = Date.now() } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(p).mtimeMs <= maxAgeDays * DAY_MS) continue;
      fs.rmSync(p, { force: true });
      removed.push(p);
    } catch {
      continue;
    }
  }
  return removed;
}
