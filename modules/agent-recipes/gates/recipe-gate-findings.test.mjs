/**
 * The findings subcommand of recipe-gate and the resume preference for its
 * sidecar. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-gate.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-gate-findings-"));
const env = { ...process.env, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let counter = 0;
const dir = () => {
  const d = path.join(tmp, `d${counter++}`);
  fs.mkdirSync(d);
  return d;
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const gate = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: opts.cwd, env: { ...env, ...opts.env } });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

const repo = dir();
git(repo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "sum.sh"), "add() { echo $(($1 + $2)); }\nsub() { echo $(($1 - $2)); }\n");
fs.writeFileSync(path.join(repo, "test.sh"), '. ./sum.sh\ntest "$(add 1 2)" = 3\n');
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
const worktree = path.join(dir(), "wt");
git(repo, "worktree", "add", "-q", "-b", "wt", worktree);

const check = "sh test.sh";
const review = (text) => {
  const f = path.join(dir(), "review.md");
  fs.writeFileSync(f, text);
  return f;
};
const runFindings = (text, extra = [], checkCmd = check) => {
  const f = review(text);
  const r = gate(["findings", f, "--check", checkCmd, "--worktree", worktree, ...extra]);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  const side = JSON.parse(fs.readFileSync(`${f}.findings.json`, "utf8"));
  assert.equal(side.verdict, r.json.verdict);
  return { ...r, file: f };
};
const patch = (line, from, to) => `--- a/sum.sh
+++ b/sum.sh
@@ -${line} +${line} @@
-${from}
+${to}
`;

// a reproduced small finding blocks
{
  const r = runFindings("# Review\n\n## Blocking\n\nnone\n\n## Small findings\n\n```sh\nexit 1\n```\n").json;
  assert.equal(r.verdict, "needs-work");
  assert.equal(r.ok, true);
  assert.equal(r.reproduced[0].n, 1);
  assert.equal(r.reproduced[0].kind, "sh");
  assert.equal(r.reproduced[0].title, "Small findings");
  assert.equal(r.reproduced[0].exit, 1);
  assert.equal(r.findings, 1);
}

// an unreproduced blocking finding does not block; other fences are ignored
{
  const r = runFindings("## Blocking: add is wrong\n\n```sh\ntrue\n```\n\n```text\nexit 1\n```\n\n```\nexit 1\n```\n").json;
  assert.equal(r.verdict, "clean");
  assert.equal(r.unreproduced.length, 1);
  assert.equal(r.unreproduced[0].title, "Blocking: add is wrong");
  assert.equal(r.findings, 1);
}

// diff blocks: an uncovered change reproduces, a covered one does not
{
  const r = runFindings(`## Uncovered\n\n\`\`\`diff\n${patch("2,0", "sub() { echo $(($1 - $2)); }", "sub() { echo 0; }")}\`\`\`\n\n## Covered\n\n\`\`\`diff\n${patch("1", "add() { echo $(($1 + $2)); }", "add() { echo 0; }")}\`\`\`\n`).json;
  assert.equal(r.verdict, "needs-work");
  assert.equal(r.reproduced.length, 1);
  assert.equal(r.reproduced[0].kind, "diff");
  assert.equal(r.reproduced[0].summary, "sum.sh");
  assert.equal(r.reproduced[0].n, 1);
  assert.equal(r.unreproduced.length, 1);
  assert.equal(r.unreproduced[0].n, 2);
}

// unrunnable blocks
{
  const r = runFindings("## A\n\n```diff\n--- a/nope.sh\n+++ b/nope.sh\n@@ -1 +1 @@\n-x\n+y\n```\n").json;
  assert.equal(r.verdict, "clean");
  assert.equal(r.unrunnable.length, 1);
  assert.match(r.unrunnable[0].reason, /^patch does not apply/);
  const t = runFindings("## A\n\n```sh\nsleep 5\n```\n", ["--timeout-ms", "500"]).json;
  assert.equal(t.unrunnable.length, 1);
  assert.match(t.unrunnable[0].reason, /^timed out/);
  assert.equal(t.verdict, "clean");
}

// no reproductions, and a failing check
{
  const r = runFindings("# Review\n\nLooks fine.\n").json;
  assert.equal(r.verdict, "clean");
  assert.equal(r.findings, 0);
  assert.equal(r.check.exit, 0);
  const f = runFindings("## A\n\n```sh\nexit 1\n```\n", [], "exit 3").json;
  assert.equal(f.verdict, "needs-work");
  assert.equal(f.check.exit, 3);
  assert.equal(f.unrunnable[0].reason, "the check fails at head");
  assert.equal(f.reproduced.length, 0);
}

// the cap
{
  const blocks = Array.from({ length: 12 }, (_, i) => `## F${i}\n\n\`\`\`sh\ntrue\n\`\`\`\n`).join("\n");
  const r = runFindings(blocks).json;
  assert.equal(r.unreproduced.length, 10);
  assert.equal(r.unrunnable.length, 2);
  assert.equal(r.unrunnable[0].reason, "over the cap of 10 reproductions");
}

// stray changes in the worktree are cleared first
{
  fs.writeFileSync(path.join(worktree, "stray.txt"), "x");
  fs.appendFileSync(path.join(worktree, "sum.sh"), "# edit\n");
  assert.equal(runFindings("nothing\n").json.verdict, "clean");
}

// a reproduction that commits or switches branch is undone before the next one
for (const [name, cmd] of [["commit", "echo x > moved.txt && git add moved.txt && git commit -qm moved"], ["branch", "git checkout -q -b other"]]) {
  const before = git(worktree, "rev-parse", "HEAD");
  const branchBefore = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  const r = runFindings(`## A\n\n\`\`\`sh\n${cmd}\n\`\`\`\n\n## B\n\n\`\`\`sh\ntest ! -e moved.txt && test \"$(git rev-parse --abbrev-ref HEAD)\" != other\n\`\`\`\n`).json;
  assert.equal(git(worktree, "rev-parse", "HEAD"), before, name);
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), branchBefore, name);
  assert.equal(r.verdict, "clean", name);
  assert.deepEqual(r.reproduced, [], name);
  assert.equal(r.check.exit, 0);
  spawnSync("git", ["branch", "-D", "other"], { cwd: worktree, env });
}

// no verdict cases
{
  const missing = gate(["findings", path.join(dir(), "none.md"), "--check", check, "--worktree", worktree]);
  assert.equal(missing.status, 0);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.verdict, null);
  for (const head of ["handoff: x", "blocked: y"]) {
    const f = review(`${head}\n\n\`\`\`sh\nexit 1\n\`\`\`\n`);
    const r = gate(["findings", f, "--check", check, "--worktree", worktree]);
    assert.equal(r.status, 0);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.verdict, null);
    assert.equal(r.json.reason, head === "blocked: y" ? "review is blocked: y" : "review is a handoff");
  }
  const noCheck = gate(["findings", review("x\n"), "--worktree", worktree]);
  assert.equal(noCheck.status, 2);
}

// a skip-worktree edit made by a reproduction does not outlive it
{
  const r = runFindings('# Review\n\n## Small findings\n\n```sh\ngit update-index --skip-worktree sum.sh\necho tampered > sum.sh\nexit 1\n```\n\n```sh\ntest "$(cat sum.sh)" = tampered && exit 1\nexit 0\n```\n').json;
  assert.equal(r.reproduced.length, 1);
  assert.equal(r.unreproduced.length, 1);
  assert.equal(r.unreproduced[0].n, 2);
  assert.equal(git(worktree, "ls-files", "-v").split("\n").filter((l) => l.startsWith("S")).length, 0);
}

// --run records the worktree
{
  const root = dir();
  const rooted = path.join(root, "repo", "r-review-1");
  git(repo, "worktree", "add", "-q", "-b", "recipe/r-review-1", rooted);
  const run = dir();
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ repo, made: [] }));
  const f = review("nothing\n");
  const r = gate(["findings", f, "--check", check, "--worktree", rooted, "--run", run, "--id", "x"], { cwd: rooted, env: { RECIPE_WORKTREE_ROOT: root } });
  assert.equal(r.json.recorded, true);
  assert.equal(r.json.branch, "recipe/r-review-1");
  const ledger = JSON.parse(fs.readFileSync(path.join(run, "run.json"), "utf8"));
  assert.ok(ledger.made.some((m) => m.kind === "review" && m.branch === "recipe/r-review-1"));
}

// resume prefers the sidecar
{
  const run = dir();
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ repo, base: "x", made: [{ kind: "task", id: "t", branch: "main", worktree: "/x/t" }] }));
  const f = path.join(run, "review-t-1.md");
  fs.writeFileSync(f, "Does what was asked: partly\nSound: yes\n");
  assert.equal(gate(["resume", run, "--repo", repo]).json.tasks.t.review, "needs-work");
  fs.writeFileSync(`${f}.findings.json`, JSON.stringify({ verdict: "clean" }));
  assert.equal(gate(["resume", run, "--repo", repo]).json.tasks.t.review, "clean");
  fs.writeFileSync(`${f}.findings.json`, "not json");
  assert.equal(gate(["resume", run, "--repo", repo]).json.tasks.t.review, "needs-work");
}

// a mutator's report: tried is read, claims are optional
{
  const mutator = `## Survivor 1: sum.sh:2\n\nThe subtraction is not covered.\n\n\`\`\`diff\n${patch("2,0", "sub() { echo $(($1 - $2)); }", "sub() { echo 0; }")}\`\`\`\n\nTried: 4, survived: 1, caught: 3, did not build: 0\n`;
  const r = runFindings(mutator);
  assert.equal(r.json.tried, 4);
  assert.equal(r.json.reproduced[0].n, 1);
  assert.equal(r.json.verdict, "needs-work");
  assert.deepEqual(r.json.claimed, []);
  assert.equal(JSON.parse(fs.readFileSync(`${r.file}.findings.json`, "utf8")).tried, 4);

  const fix = review("done\n\n## Equivalent 1\nThe constant is dead code.\n\n## Equivalent 7\n\n## Notes\nx\n");
  const c = runFindings(mutator, ["--claims", fix]).json;
  assert.deepEqual(c.claimed, [{ n: 1, reason: "The constant is dead code." }, { n: 7, reason: "" }]);
  assert.equal(c.reproduced.length, 1);
  assert.equal(c.reproduced[0].n, 1);
  assert.equal(c.verdict, "needs-work");
}

// a missing claims file, no Tried line, and the missing review
{
  const m = runFindings("# Review\n\nLooks fine.\n", ["--claims", path.join(dir(), "none.md")]).json;
  assert.deepEqual(m.claimed, []);
  assert.equal(m.tried, null);
  const missing = gate(["findings", path.join(dir(), "none.md"), "--check", check, "--worktree", worktree]).json;
  assert.equal(missing.tried, null);
  assert.deepEqual(missing.claimed, []);
}
