import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 30 * 1000;
const LOCK_GIVE_UP_MS = 60 * 1000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 1500;

function run(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status ?? -1,
    out: (r.stdout ?? "").trim(),
    err: ((r.stderr ?? "") + (r.error ? String(r.error.message) : "")).trim(),
  };
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ledgerPath(dir) {
  return path.join(dir, "run.json");
}

function readLedger(dir) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function emptyLedger() {
  return { repo: null, base: null, base_ref: null, made: [], merges: {} };
}

function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = ledgerPath(dir) + ".lock";
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS || Date.now() - started > LOCK_GIVE_UP_MS) {
        try {
          fs.rmdirSync(lock);
        } catch {
          // another process removed it first
        }
        continue;
      }
      sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // taken over as stale by another process
    }
  }
}

// fn gets the ledger as it is under the lock (an empty one when absent) and
// returns the ledger to write, or undefined to leave the file alone.
function update(dir, fn) {
  return withLock(dir, () => {
    const current = readLedger(dir) ?? emptyLedger();
    current.made ??= [];
    current.merges ??= {};
    const next = fn(current);
    if (next === undefined) return current;
    const tmp = path.join(dir, `run.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, ledgerPath(dir));
    return next;
  });
}

function addMade(ledger, entry) {
  const e = {
    kind: entry.kind ?? "merge",
    id: entry.id ?? null,
    branch: entry.branch ?? null,
    worktree: entry.worktree ?? null,
  };
  const dup = ledger.made.some((m) => m.branch === e.branch && m.worktree === e.worktree);
  if (!dup) ledger.made.push(e);
  return !dup;
}

function slug(dir) {
  const s = path.basename(path.resolve(dir)).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  const hash = crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8);
  return `${s || "run"}-${hash}`;
}

export function pin(dir, { repo } = {}) {
  try {
    let outcome = null;
    update(dir, (ledger) => {
      if (ledger.base && ledger.base_ref && ledger.repo) {
        const cur = run(ledger.repo, ["rev-parse", "--verify", "-q", `${ledger.base_ref}^{commit}`]);
        if (cur.status === 0) {
          outcome = { ok: true, reason: null, repo: ledger.repo, base: ledger.base, base_ref: ledger.base_ref, reused: true };
          return undefined;
        }
      }
      if (!repo) {
        outcome = { ok: false, reason: "repo is required" };
        return undefined;
      }
      const top = run(repo, ["rev-parse", "--show-toplevel"]);
      if (top.status !== 0) {
        outcome = { ok: false, reason: `not a git repository: ${repo}` };
        return undefined;
      }
      const head = run(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head.status !== 0) {
        outcome = { ok: false, reason: `cannot resolve HEAD in ${repo}: ${head.err}` };
        return undefined;
      }
      const ref = `refs/recipes/${slug(dir)}/base`;
      const made = run(repo, ["update-ref", ref, head.out]);
      if (made.status !== 0) {
        outcome = { ok: false, reason: `update-ref failed: ${made.err}` };
        return undefined;
      }
      ledger.repo = real(top.out);
      ledger.base = head.out;
      ledger.base_ref = ref;
      outcome = { ok: true, reason: null, repo: ledger.repo, base: head.out, base_ref: ref, reused: false };
      return ledger;
    });
    return outcome;
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e) };
  }
}

export function record(dir, entry = {}) {
  try {
    let added = false;
    update(dir, (ledger) => {
      added = addMade(ledger, entry);
      return added ? ledger : undefined;
    });
    return { ok: true, added, ledger: ledgerPath(dir) };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e) };
  }
}

export function where(cwd) {
  const r = run(cwd, ["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel", "HEAD"]);
  if (r.status !== 0) return { linked: false, branch: null, worktree: null, head: null };
  const [gitDir, common, top, head] = r.out.split("\n");
  const base = path.resolve(cwd);
  const linked = real(path.resolve(base, gitDir)) !== real(path.resolve(base, common));
  const branch = run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return { linked, branch: branch.status === 0 ? branch.out : null, worktree: real(top), head: head ?? null };
}

function unmergedFiles(wt) {
  const r = run(wt, ["diff", "--name-only", "--diff-filter=U"]);
  return r.out ? r.out.split("\n") : [];
}

function mergeInProgress(wt) {
  const p = run(wt, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  if (p.status !== 0) return null;
  const file = path.resolve(wt, p.out);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").trim().split("\n")[0];
}

function isAncestor(wt, sha) {
  return run(wt, ["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0;
}

function tail(text) {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text;
}

// A hand-resolved merge may only differ from git's own merge result in paths
// that conflicted.
function resolutionProblem(wt, conflict, tipSha) {
  const merges = run(wt, ["rev-list", "--merges", "--parents", "HEAD"]);
  let parents = null;
  for (const line of merges.out.split("\n")) {
    const [commit, first, second] = line.split(" ");
    if (second === tipSha) {
      parents = { commit, first };
      break;
    }
  }
  if (!parents) return `no merge commit of ${conflict.id} found`;
  const mt = run(wt, ["merge-tree", "--write-tree", parents.first, tipSha]);
  const tree = mt.out.split("\n")[0];
  if (mt.status > 1 || !/^[0-9a-f]{40,64}$/.test(tree)) return `merge-tree failed: ${mt.err}`;
  const diff = run(wt, ["diff", "--name-only", tree, `${parents.commit}^{tree}`]);
  if (diff.status !== 0) return `diff failed: ${diff.err}`;
  const changed = diff.out ? diff.out.split("\n") : [];
  const outside = changed.filter((f) => !conflict.files.includes(f));
  if (outside.length) return `resolution of ${conflict.id} edits files that did not conflict: ${outside.join(", ")}`;
  const later = run(wt, ["diff", "--name-only", parents.commit, "HEAD"]);
  if (later.status !== 0) return `diff failed: ${later.err}`;
  const laterOutside = (later.out ? later.out.split("\n") : []).filter((f) => !conflict.files.includes(f));
  if (laterOutside.length) return `commits after the merge of ${conflict.id} edit files that did not conflict: ${laterOutside.join(", ")}`;
  return null;
}

export function merge(worktree, opts = {}) {
  const { dir, branch, onto, tips: tipSpec, check, kind, id, refresh } = opts;
  const wt = path.resolve(worktree);
  const out = {
    ok: false,
    reason: null,
    worktree: wt,
    branch: null,
    head: null,
    onto: null,
    tips: [],
    merged: [],
    conflict: null,
    resolved: [],
    check: null,
  };
  try {
    return mergeSteps(wt, out, { dir, branch, onto, tipSpec, check, kind, id, refresh });
  } catch (e) {
    out.ok = false;
    out.reason = String(e.message ?? e);
    return out;
  }
}

function mergeSteps(wt, out, o) {
  const fail = (reason) => {
    out.ok = false;
    out.reason = reason;
    if (fs.existsSync(wt)) {
      const h = run(wt, ["rev-parse", "--verify", "-q", "HEAD"]);
      out.head = h.status === 0 ? h.out : null;
    }
    return out;
  };

  const ledger = o.dir ? readLedger(o.dir) : null;
  if (!ledger || !ledger.base || !ledger.base_ref || !ledger.repo) return fail("run not pinned");
  const repo = ledger.repo;
  out.onto = o.onto ?? ledger.base_ref;

  // Step 2: tips are fixed the first time this worktree is seen; refresh replaces those of the given ids.
  let stored = ledger.merges?.[wt]?.tips;
  if (!stored || o.refresh) {
    const resolved = [];
    for (const spec of list(o.tipSpec)) {
      const at = spec.indexOf(":");
      const tipId = at < 0 ? spec : spec.slice(0, at);
      const tipBranch = at < 0 ? spec : spec.slice(at + 1);
      const r = run(repo, ["rev-parse", "--verify", "-q", `${tipBranch}^{commit}`]);
      if (r.status !== 0) return fail(`tip ${tipId}: cannot resolve ${tipBranch}`);
      resolved.push([tipId, r.out]);
    }
    update(o.dir, (l) => {
      l.merges[wt] ??= { tips: resolved, conflict: null };
      if (stored) {
        const tips = l.merges[wt].tips;
        for (const [tipId, sha] of resolved) {
          const at = tips.findIndex(([x]) => x === tipId);
          if (at < 0) tips.push([tipId, sha]);
          else tips[at] = [tipId, sha];
        }
      }
      stored = l.merges[wt].tips;
      return l;
    });
  }
  out.tips = stored.map(([tipId, sha]) => ({ id: tipId, sha }));

  // Step 3: the worktree.
  if (!fs.existsSync(wt)) {
    const name = o.branch ?? path.basename(wt);
    const exists = run(repo, ["show-ref", "--verify", "-q", `refs/heads/${name}`]).status === 0;
    const added = exists
      ? run(repo, ["worktree", "add", wt, name])
      : run(repo, ["worktree", "add", "-b", name, wt, out.onto]);
    if (added.status !== 0) return fail(`worktree add failed: ${added.err}`);
  }
  const cur = run(wt, ["symbolic-ref", "--short", "-q", "HEAD"]);
  out.branch = cur.status === 0 ? cur.out : null;
  if (o.branch && out.branch !== o.branch) {
    return fail(`worktree is on ${out.branch ?? "a detached HEAD"}, not ${o.branch}`);
  }
  update(o.dir, (l) => {
    addMade(l, { kind: o.kind ?? "merge", id: o.id ?? path.basename(wt), branch: out.branch, worktree: wt });
    return l;
  });

  // Step 4: a merge left open by an earlier call.
  const open = mergeInProgress(wt);
  if (open) {
    const files = unmergedFiles(wt);
    const tip = stored.find(([, sha]) => sha === open);
    const tipId = tip ? tip[0] : open;
    if (files.length) {
      out.conflict = { id: tipId, files };
      return fail(`merge of ${tipId} has conflicts`);
    }
    const committed = run(wt, ["commit", "--no-edit"]);
    if (committed.status !== 0) return fail(`merge of ${tipId} not committed: ${committed.err || committed.out}`);
  }
  if (run(wt, ["status", "--porcelain", "--untracked-files=no"]).out) {
    return fail("uncommitted changes in the worktree");
  }

  // Step 5: a recorded conflict whose tip has since been merged by hand.
  const recorded = readLedger(o.dir)?.merges?.[wt]?.conflict;
  if (recorded) {
    const tip = stored.find(([tipId]) => tipId === recorded.id);
    if (tip && isAncestor(wt, tip[1])) {
      const problem = resolutionProblem(wt, recorded, tip[1]);
      if (problem) {
        out.conflict = recorded;
        return fail(problem);
      }
      update(o.dir, (l) => {
        if (l.merges[wt]) l.merges[wt].conflict = null;
        return l;
      });
      out.resolved.push({ id: recorded.id, files: recorded.files });
    }
  }

  // Step 6: remaining tips in order.
  for (const [tipId, sha] of stored) {
    if (isAncestor(wt, sha)) {
      out.merged.push(tipId);
      continue;
    }
    const m = run(wt, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${tipId}`, sha]);
    if (m.status === 0) {
      out.merged.push(tipId);
      continue;
    }
    const files = unmergedFiles(wt);
    if (files.length) {
      out.conflict = { id: tipId, files };
      update(o.dir, (l) => {
        l.merges[wt] ??= { tips: stored, conflict: null };
        l.merges[wt].conflict = out.conflict;
        return l;
      });
      return fail(`merge of ${tipId} has conflicts`);
    }
    run(wt, ["merge", "--abort"]);
    return fail(`merge of ${tipId} failed: ${m.err || m.out}`);
  }

  const h = run(wt, ["rev-parse", "HEAD"]);
  out.head = h.status === 0 ? h.out : null;

  // Step 7: the check.
  if (o.check) {
    const r = spawnSync("sh", ["-c", o.check], { cwd: wt, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const exit = r.status ?? -1;
    out.check = { command: o.check, exit, tail: tail(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()) };
    if (exit !== 0) {
      out.ok = false;
      out.reason = `check exited ${exit}`;
      return out;
    }
  }
  out.ok = true;
  return out;
}

export function abandon(dir, { keep, kinds } = {}) {
  const res = { ok: true, removed: { worktrees: [], branches: [], refs: [] }, kept: [], left: [], problems: [] };
  const ledger = readLedger(dir);
  if (!ledger) return res;
  const keepSet = new Set(list(keep));
  const kindSet = list(kinds);
  const entries = ledger.made.filter((m) => kindSet.length === 0 || kindSet.includes(m.kind));
  const repo = ledger.repo;
  const own = real(repo);
  const listed = new Set(
    run(repo, ["worktree", "list", "--porcelain"])
      .out.split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => real(l.slice("worktree ".length))),
  );

  const doomedBranches = [];
  for (const m of entries) {
    if (!m.branch) continue;
    const tip = run(repo, ["rev-parse", "--verify", "-q", `refs/heads/${m.branch}`]);
    if (tip.status !== 0) continue;
    if (keepSet.has(m.branch)) {
      if (!res.kept.includes(m.branch)) res.kept.push(m.branch);
      res.left.push(m);
      continue;
    }
    if (!doomedBranches.some((b) => b.branch === m.branch)) doomedBranches.push({ branch: m.branch, tip: tip.out });
  }
  const dropBase = kindSet.length === 0 || kindSet.includes("base");
  let baseSha = null;
  if (dropBase && ledger.base_ref) {
    const b = run(repo, ["rev-parse", "--verify", "-q", ledger.base_ref]);
    if (b.status === 0) baseSha = b.out;
  }

  if (doomedBranches.length || baseSha) {
    const file = path.join(dir, "abandoned.json");
    let prior = { branches: [], refs: [] };
    try {
      prior = { ...prior, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      // first abandon
    }
    for (const b of doomedBranches) if (!prior.branches.some((p) => p.branch === b.branch)) prior.branches.push(b);
    if (baseSha) prior.refs.push({ ref: ledger.base_ref, sha: baseSha });
    fs.writeFileSync(file, JSON.stringify(prior, null, 2) + "\n");
  }

  for (const m of entries) {
    if (!m.worktree) continue;
    const w = real(m.worktree);
    if (w === own || !listed.has(w)) continue;
    const r = run(repo, ["worktree", "remove", "--force", m.worktree]);
    if (r.status === 0) res.removed.worktrees.push(m.worktree);
    else {
      res.problems.push(`worktree ${m.worktree}: ${r.err}`);
      if (!res.left.includes(m)) res.left.push(m);
    }
  }
  run(repo, ["worktree", "prune"]);

  for (const b of doomedBranches) {
    const r = run(repo, ["branch", "-D", b.branch]);
    if (r.status === 0) res.removed.branches.push(b);
    else {
      res.problems.push(`branch ${b.branch}: ${r.err}`);
      res.left.push(...entries.filter((m) => m.branch === b.branch && !res.left.includes(m)));
    }
  }
  if (baseSha) {
    const r = run(repo, ["update-ref", "-d", ledger.base_ref]);
    if (r.status === 0) res.removed.refs.push(ledger.base_ref);
    else res.problems.push(`ref ${ledger.base_ref}: ${r.err}`);
  }
  res.ok = res.problems.length === 0;
  return res;
}
