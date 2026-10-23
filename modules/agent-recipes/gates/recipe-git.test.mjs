import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { abandon, merge, pin, record, where } from "./recipe-git.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.join(here, "recipe-git.mjs")).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-git-"));

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(cwd, file, text, message = `edit ${file}`) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

let counter = 0;
function scenario() {
  const root = path.join(tmp, `s${counter++}`);
  const repo = path.join(root, "repo");
  const dir = path.join(root, "run dir");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "a.txt", "one\ntwo\nthree\n", "initial");
  commitFile(repo, "b.txt", "bee\n", "second file");
  const ledger = () => JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  return { root, repo, dir, ledger };
}

function branchFrom(repo, name, from, file, text) {
  if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/heads/${name}`], { cwd: repo }).status !== 0) git(repo, "branch", name, from);
  const wt = path.join(path.dirname(repo), `tmp-${name.replace(/\//g, "_")}`);
  git(repo, "worktree", "add", "-q", wt, name);
  const sha = commitFile(wt, file, text, `${name} edits ${file}`);
  git(repo, "worktree", "remove", "--force", wt);
  return sha;
}

function child(code) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (status) => resolve({ status, out }));
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("pin reuses the base after a later commit", () => {
  const s = scenario();
  const first = pin(s.dir, { repo: s.repo });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.base, git(s.repo, "rev-parse", "HEAD"));
  assert.match(first.base_ref, /^refs\/recipes\/run-dir-[0-9a-f]{8}\/base$/);
  commitFile(s.repo, "c.txt", "later\n");
  const second = pin(s.dir, { repo: s.repo });
  assert.equal(second.reused, true);
  assert.equal(second.base, first.base);
  assert.equal(git(s.repo, "rev-parse", first.base_ref), first.base);
});

test("pin repins when the base ref is gone", () => {
  const s = scenario();
  const first = pin(s.dir, { repo: s.repo });
  git(s.repo, "update-ref", "-d", first.base_ref);
  const newer = commitFile(s.repo, "c.txt", "later\n");
  const second = pin(s.dir, { repo: s.repo });
  assert.equal(second.reused, false);
  assert.equal(second.base, newer);
});

test("pin keeps two plan dirs with the same name apart", () => {
  const s = scenario();
  const a = pin(path.join(s.root, "a", "322"), { repo: s.repo });
  const b = pin(path.join(s.root, "b", "322"), { repo: s.repo });
  assert.notEqual(a.base_ref, b.base_ref);
});

test("pin strips a leading dot from the ref name", () => {
  const s = scenario();
  const dir = path.join(s.root, ".hidden");
  const r = pin(dir, { repo: s.repo });
  assert.match(r.base_ref, /^refs\/recipes\/hidden-[0-9a-f]{8}\/base$/);
});

test("merge before pin reports the run is not pinned", () => {
  const s = scenario();
  const r = merge(path.join(s.root, "wt"), { dir: s.dir, branch: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "run not pinned");
});

test("merge creates the worktree at the pinned base and empty tips give a plain worktree", () => {
  const s = scenario();
  const p = pin(s.dir, { repo: s.repo });
  commitFile(s.repo, "c.txt", "newer\n");
  const wt = path.join(s.root, "wt");
  const r = merge(wt, { dir: s.dir, branch: "work", tips: "", kind: "integration", id: "integration" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, p.base);
  assert.deepEqual(r.merged, []);
  assert.equal(r.branch, "work");
  assert.equal(r.check, null);
  assert.equal(git(wt, "rev-parse", "HEAD"), p.base);
  assert.deepEqual(s.ledger().made, [{ kind: "integration", id: "integration", branch: "work", worktree: wt }]);
  const again = merge(wt, { dir: s.dir, branch: "work", tips: "" });
  assert.equal(again.ok, true);
  assert.equal(s.ledger().made.length, 1);
});

test("merge refuses a worktree on another branch", () => {
  const s = scenario();
  pin(s.dir, { repo: s.repo });
  const wt = path.join(s.root, "wt");
  assert.equal(merge(wt, { dir: s.dir, branch: "one" }).ok, true);
  const r = merge(wt, { dir: s.dir, branch: "two" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not two/);
});

test("merge onto an explicit ref", () => {
  const s = scenario();
  pin(s.dir, { repo: s.repo });
  const newer = commitFile(s.repo, "c.txt", "newer\n");
  const r = merge(path.join(s.root, "wt"), { dir: s.dir, branch: "work", onto: "main" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, newer);
  assert.equal(r.onto, "main");
});

test("merge records tips on first call and ignores later moves", () => {
  const s = scenario();
  const p = pin(s.dir, { repo: s.repo });
  const t1 = branchFrom(s.repo, "t1", p.base, "x.txt", "x\n");
  const t2 = branchFrom(s.repo, "t2", p.base, "y.txt", "y\n");
  const wt = path.join(s.root, "wt");
  const first = merge(wt, { dir: s.dir, branch: "work", tips: "T1:t1,T2:t2" });
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(first.merged, ["T1", "T2"]);
  assert.deepEqual(first.tips, [
    { id: "T1", sha: t1 },
    { id: "T2", sha: t2 },
  ]);
  assert.deepEqual(s.ledger().merges[wt].tips, [["T1", t1], ["T2", t2]]);
  assert.equal(fs.readFileSync(path.join(wt, "y.txt"), "utf8"), "y\n");
  assert.match(git(wt, "log", "-1", "--format=%s"), /^Merge T2$/);

  const moved = branchFrom(s.repo, "t1", "t1", "z.txt", "moved\n");
  assert.notEqual(moved, t1);
  const second = merge(wt, { dir: s.dir, branch: "work", tips: "T1:t1,T2:t2" });
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.tips[0].sha, t1);
  assert.equal(second.head, first.head);
  assert.equal(fs.existsSync(path.join(wt, "z.txt")), false);
});

test("merge reports an unresolvable tip", () => {
  const s = scenario();
  pin(s.dir, { repo: s.repo });
  const r = merge(path.join(s.root, "wt"), { dir: s.dir, branch: "work", tips: "T1:nope" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot resolve nope/);
});

function conflictScenario() {
  const s = scenario();
  const p = pin(s.dir, { repo: s.repo });
  // both sides edit a.txt line two; t2 also adds a clean change to b.txt
  git(s.repo, "branch", "t1", p.base);
  git(s.repo, "branch", "t2", p.base);
  const w1 = path.join(s.root, "w1");
  const w2 = path.join(s.root, "w2");
  git(s.repo, "worktree", "add", "-q", w1, "t1");
  git(s.repo, "worktree", "add", "-q", w2, "t2");
  commitFile(w1, "a.txt", "one\nfrom t1\nthree\n");
  commitFile(w2, "a.txt", "one\nfrom t2\nthree\n");
  commitFile(w2, "b.txt", "bee changed by t2\n");
  git(s.repo, "worktree", "remove", "--force", w1);
  git(s.repo, "worktree", "remove", "--force", w2);
  const wt = path.join(s.root, "wt");
  const first = merge(wt, { dir: s.dir, branch: "work", tips: "T1:t1,T2:t2" });
  return { ...s, wt, first };
}

test("merge stops on a conflict and lists the files", () => {
  const s = conflictScenario();
  assert.equal(s.first.ok, false);
  assert.deepEqual(s.first.conflict, { id: "T2", files: ["a.txt"] });
  assert.deepEqual(s.first.merged, ["T1"]);
  assert.deepEqual(s.ledger().merges[s.wt].conflict, { id: "T2", files: ["a.txt"] });
  const again = merge(s.wt, { dir: s.dir, branch: "work", tips: "T1:t1,T2:t2" });
  assert.equal(again.ok, false);
  assert.deepEqual(again.conflict, { id: "T2", files: ["a.txt"] });
});

test("merge commits a merge that is resolved and staged but not committed", () => {
  const s = conflictScenario();
  fs.writeFileSync(path.join(s.wt, "a.txt"), "one\nboth\nthree\n");
  git(s.wt, "add", "a.txt");
  const r = merge(s.wt, { dir: s.dir, branch: "work" });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.resolved, [{ id: "T2", files: ["a.txt"] }]);
});

test("merge refuses a later commit that edits a file that did not conflict", () => {
  const s = conflictScenario();
  fs.writeFileSync(path.join(s.wt, "a.txt"), "one\nboth\nthree\n");
  git(s.wt, "add", "a.txt");
  git(s.wt, "commit", "-q", "--no-edit");
  commitFile(s.wt, "b.txt", "changed later\n");
  const r = merge(s.wt, { dir: s.dir, branch: "work", check: "true" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /b\.txt/);
  assert.deepEqual(r.resolved, []);
});

test("merge accepts a resolution committed by hand", () => {
  const s = conflictScenario();
  fs.writeFileSync(path.join(s.wt, "a.txt"), "one\nboth\nthree\n");
  git(s.wt, "add", "a.txt");
  git(s.wt, "commit", "-q", "--no-edit");
  const r = merge(s.wt, { dir: s.dir, branch: "work", tips: "T1:t1,T2:t2" });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.resolved, [{ id: "T2", files: ["a.txt"] }]);
  assert.equal(r.conflict, null);
  assert.equal(s.ledger().merges[s.wt].conflict, null);
  const third = merge(s.wt, { dir: s.dir, branch: "work" });
  assert.equal(third.ok, true);
  assert.deepEqual(third.resolved, []);
});

test("merge refuses a resolution that edits another file", () => {
  const s = conflictScenario();
  fs.writeFileSync(path.join(s.wt, "a.txt"), "one\nboth\nthree\n");
  fs.writeFileSync(path.join(s.wt, "extra.txt"), "sneaky\n");
  git(s.wt, "add", "a.txt", "extra.txt");
  git(s.wt, "commit", "-q", "--no-edit");
  const r = merge(s.wt, { dir: s.dir, branch: "work" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /extra\.txt/);
  assert.deepEqual(r.resolved, []);
});

test("merge refuses a resolution that reverts a clean change from the tip", () => {
  const s = conflictScenario();
  fs.writeFileSync(path.join(s.wt, "a.txt"), "one\nboth\nthree\n");
  fs.writeFileSync(path.join(s.wt, "b.txt"), "bee\n");
  git(s.wt, "add", "a.txt", "b.txt");
  git(s.wt, "commit", "-q", "--no-edit");
  const r = merge(s.wt, { dir: s.dir, branch: "work" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /b\.txt/);
});

test("merge check exit status decides ok", () => {
  const s = scenario();
  pin(s.dir, { repo: s.repo });
  const wt = path.join(s.root, "wt");
  const bad = merge(wt, { dir: s.dir, branch: "work", check: "echo boom; exit 3" });
  assert.equal(bad.ok, false);
  assert.equal(bad.check.exit, 3);
  assert.match(bad.check.tail, /boom/);
  assert.equal(bad.check.command, "echo boom; exit 3");
  const good = merge(wt, { dir: s.dir, branch: "work", check: "test -f a.txt" });
  assert.equal(good.ok, true);
  assert.equal(good.check.exit, 0);
});

test("where tells a linked worktree from the main checkout", () => {
  const s = scenario();
  pin(s.dir, { repo: s.repo });
  const main = where(s.repo);
  assert.equal(main.linked, false);
  assert.equal(main.branch, "main");
  const wt = path.join(s.root, "wt");
  merge(wt, { dir: s.dir, branch: "work" });
  const linked = where(wt);
  assert.equal(linked.linked, true);
  assert.equal(linked.branch, "work");
  assert.equal(linked.worktree, fs.realpathSync(wt));
  assert.equal(linked.head, git(wt, "rev-parse", "HEAD"));
  assert.equal(where(s.root).linked, false);
});

test("record creates the ledger and skips duplicates", () => {
  const s = scenario();
  const e = { kind: "task", id: "t1", branch: "b1", worktree: "/x/y" };
  assert.equal(record(s.dir, e).added, true);
  assert.equal(record(s.dir, e).added, false);
  assert.deepEqual(s.ledger().made, [e]);
});

test("concurrent record calls all land", async () => {
  const s = scenario();
  fs.mkdirSync(s.dir, { recursive: true });
  const n = 12;
  const procs = [];
  for (let i = 0; i < n; i++) {
    procs.push(
      child(
        `import { record } from ${JSON.stringify(moduleUrl)};
         const r = record(${JSON.stringify(s.dir)}, { kind: "task", id: "t${i}", branch: "b${i}", worktree: "/w/${i}" });
         if (!r.ok) { console.error(r.reason); process.exit(1); }`,
      ),
    );
  }
  let running = true;
  const reads = Promise.all(procs).then((r) => ((running = false), r));
  let readsDone = 0;
  while (running) {
    try {
      JSON.parse(fs.readFileSync(path.join(s.dir, "run.json"), "utf8"));
      readsDone++;
    } catch (e) {
      assert.equal(e.code, "ENOENT", `run.json unreadable mid-run: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  for (const r of await reads) assert.equal(r.status, 0, r.out);
  const made = s.ledger().made.map((m) => m.id).sort();
  assert.deepEqual(made, Array.from({ length: n }, (_, i) => `t${i}`).sort());
  assert.ok(readsDone >= 0);
  assert.equal(fs.existsSync(path.join(s.dir, "run.json.lock")), false);
});

test("concurrent merges on two worktrees keep both entries", async () => {
  const s = scenario();
  const p = pin(s.dir, { repo: s.repo });
  branchFrom(s.repo, "t1", p.base, "x.txt", "x\n");
  const wts = [path.join(s.root, "wa"), path.join(s.root, "wb"), path.join(s.root, "wc")];
  const results = await Promise.all(
    wts.map((wt, i) =>
      child(
        `import { merge } from ${JSON.stringify(moduleUrl)};
         const r = merge(${JSON.stringify(wt)}, { dir: ${JSON.stringify(s.dir)}, branch: "work${i}", tips: "T1:t1" });
         if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }`,
      ),
    ),
  );
  for (const r of results) assert.equal(r.status, 0, r.out);
  const ledger = s.ledger();
  for (const wt of wts) assert.equal(ledger.merges[real(wt)]?.tips.length, 1, `missing ${wt}`);
  assert.equal(ledger.made.length, wts.length);
});

function real(p) {
  return fs.realpathSync(p);
}

function abandonScenario() {
  const s = scenario();
  const p = pin(s.dir, { repo: s.repo });
  const mk = (name, kind) => {
    const wt = path.join(s.root, name);
    const r = merge(wt, { dir: s.dir, branch: name, kind, id: name });
    assert.equal(r.ok, true, r.reason);
    return wt;
  };
  return { ...s, base: p, a: mk("task-a", "task"), b: mk("task-b", "task"), r: mk("review-a", "review") };
}

test("abandon removes worktrees, branches and the base ref, and is idempotent", () => {
  const s = abandonScenario();
  const tipA = git(s.repo, "rev-parse", "task-a");
  const first = abandon(s.dir, {});
  assert.equal(first.ok, true, first.problems.join("; "));
  assert.equal(first.removed.worktrees.length, 3);
  assert.deepEqual(first.removed.branches.map((b) => b.branch).sort(), ["review-a", "task-a", "task-b"]);
  assert.equal(first.removed.branches.find((b) => b.branch === "task-a").tip, tipA);
  assert.deepEqual(first.removed.refs, [s.base.base_ref]);
  assert.equal(fs.existsSync(s.a), false);
  assert.equal(git(s.repo, "branch", "--list", "task-a"), "");
  assert.equal(git(s.repo, "for-each-ref", s.base.base_ref), "");
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, "abandoned.json"), "utf8"));
  assert.ok(saved.branches.some((b) => b.branch === "task-a" && b.tip === tipA));
  assert.ok(git(s.repo, "worktree", "list").split("\n").length === 1);

  const second = abandon(s.dir, {});
  assert.equal(second.ok, true);
  assert.deepEqual(second.removed, { worktrees: [], branches: [], refs: [] });
});

test("abandon honours keep", () => {
  const s = abandonScenario();
  const r = abandon(s.dir, { keep: ["task-a"] });
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.deepEqual(r.kept, ["task-a"]);
  assert.notEqual(git(s.repo, "branch", "--list", "task-a"), "");
  assert.equal(git(s.repo, "branch", "--list", "task-b"), "");
  assert.equal(fs.existsSync(s.a), false);
});

test("abandon honours kinds and leaves the base ref unless asked", () => {
  const s = abandonScenario();
  const r = abandon(s.dir, { kinds: ["review"] });
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.deepEqual(r.removed.branches.map((b) => b.branch), ["review-a"]);
  assert.deepEqual(r.removed.refs, []);
  assert.equal(fs.existsSync(s.a), true);
  assert.notEqual(git(s.repo, "for-each-ref", s.base.base_ref), "");
  const base = abandon(s.dir, { kinds: ["base"] });
  assert.deepEqual(base.removed.refs, [s.base.base_ref]);
  assert.equal(fs.existsSync(s.a), true);
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
