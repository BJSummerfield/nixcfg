/**
 * Behaviour tests for recipe-gate. Run by `nix flake check`; they drive the
 * CLI as a child process, the way a workflow gate does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-gate.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-gate-"));
let counter = 0;

const dir = () => {
  const d = path.join(tmp, `d${counter++}`);
  fs.mkdirSync(d);
  return d;
};
const write = (name, text) => {
  const f = path.join(dir(), name);
  fs.writeFileSync(f, text);
  return f;
};
const gate = (...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

// Usage errors exit nonzero with no JSON.
{
  assert.equal(gate().status, 2);
  assert.equal(gate("bogus", "x").status, 2);
  assert.equal(gate("size", tmp, "--window").status, 2);
  assert.equal(gate("size", tmp, "--window", "abc").status, 2);
  assert.equal(gate("size", path.join(tmp, "nope")).status, 1);
}

// urls: bullets under angle headings, deduped and normalized; primary wins.
{
  const f = write(
    "search.md",
    [
      "# Search results",
      "## a1",
      "- https://Example.com/docs/?utm_source=x&b=2&a=1#frag | primary | the docs",
      "- https://example.com/docs?a=1&b=2 | secondary | same page again",
      "- https://example.com/blog/ | secondary | a post | with a bar",
      "- not a url | primary | dropped",
      "- ftp://example.com/x | primary | dropped",
      "## Angle: a2",
      "* <https://other.org/x> | primary | other",
      "- https://other.org/y | weird | unknown kind",
      "prose line with https://ignored.example",
    ].join("\n"),
  );
  const r = gate("urls", f);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(
    r.json.urls.map((u) => u.url),
    ["https://example.com/docs?a=1&b=2", "https://example.com/blog", "https://other.org/x", "https://other.org/y"],
  );
  assert.equal(r.json.urls[0].kind, "primary");
  assert.equal(r.json.urls[0].angle, "a1");
  assert.equal(r.json.urls[0].why, "the docs");
  assert.equal(r.json.urls[1].why, "a post | with a bar");
  assert.equal(r.json.urls[2].angle, "a2");
  assert.equal(r.json.urls[3].kind, "secondary");
}
{
  const empty = gate("urls", write("s.md", "nothing here\n"));
  assert.equal(empty.status, 0);
  assert.deepEqual(empty.json, { ok: false, urls: [] });
  const missing = gate("urls", path.join(tmp, "absent.md"));
  assert.equal(missing.status, 0);
  assert.equal(missing.json.ok, false);
  assert.deepEqual(missing.json.urls, []);
}

// extract: counts blockquote blocks; fails on none, missing, or over the cap.
{
  const text = "# Page\n> first quote\n> continues\n\ntext\n\n> second quote\n\n>\n";
  const r = gate("extract", write("e.md", text));
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: true, bytes: Buffer.byteLength(text), quotes: 2, over_cap: false });
}
{
  const none = gate("extract", write("e.md", "no quotes at all\n"));
  assert.equal(none.json.ok, false);
  assert.equal(none.json.quotes, 0);
  const missing = gate("extract", path.join(tmp, "absent.md"));
  assert.equal(missing.status, 0);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.bytes, 0);
}
{
  const big = "> " + "x".repeat(24 * 1024) + "\n";
  const over = gate("extract", write("e.md", big));
  assert.equal(over.json.over_cap, true);
  assert.equal(over.json.ok, false);
  assert.equal(over.json.quotes, 1);
  const raised = gate("extract", write("e.md", big), "--cap", "30000");
  assert.equal(raised.json.over_cap, false);
  assert.equal(raised.json.ok, true);
  const exact = "> " + "y".repeat(98) + "\n";
  assert.equal(gate("extract", write("e.md", exact), "--cap", String(Buffer.byteLength(exact))).json.ok, true);
  assert.equal(gate("extract", write("e.md", exact), "--cap", String(Buffer.byteLength(exact) - 1)).json.over_cap, true);
}

// size: bytes under the directory, recursively; split by the half-window rule.
{
  const d = dir();
  fs.mkdirSync(path.join(d, "raw"));
  fs.writeFileSync(path.join(d, "a.md"), "a".repeat(1000));
  fs.writeFileSync(path.join(d, "raw", "b.md"), "b".repeat(3000));
  assert.deepEqual(gate("size", d).json, { bytes: 4000, est_tokens: 1000, split: 1 });
  assert.equal(gate("size", dir()).json.split, 1);
}
{
  const half = 221184 / 2;
  const at = dir();
  fs.writeFileSync(path.join(at, "x"), "x".repeat(half * 4));
  assert.equal(gate("size", at).json.split, 1);
  const over = dir();
  fs.writeFileSync(path.join(over, "x"), "x".repeat(half * 4 + 4));
  assert.equal(gate("size", over).json.split, Math.ceil((half + 1) / 70000));
  const big = dir();
  fs.writeFileSync(path.join(big, "x"), "x".repeat(4 * 300000));
  assert.equal(gate("size", big).json.split, 5);
  assert.equal(gate("size", big, "--window", "1000000").json.split, 1);
  const small = dir();
  fs.writeFileSync(path.join(small, "x"), "x".repeat(4 * 60000));
  assert.equal(gate("size", small, "--window", "100000").json.split, 2);
}

// verdict: the first verdict line and the few after it decide, up to the
// next heading; anything missing is invalid.
{
  const v = (text) => gate("verdict", write("review.md", text)).json;
  assert.deepEqual(v("Does what was asked: yes, as briefed.\nSound: yes, check passed.\n\n## Blocking\n"), {
    asked: "yes",
    sound: "yes",
    clean: true,
    verdict: "clean",
  });
  assert.equal(v("`Does what was asked: partly`, one gap.\n`Sound: yes`.\n").verdict, "needs-work");
  assert.equal(v("\nDoes what was asked: yes\nSound: no, not checked\n").clean, false);
  assert.equal(v("Does what was asked: no\nSound: yes\n").asked, "no");
  assert.equal(v("Does what was asked: yes\n").verdict, "invalid");
  assert.equal(v("Sound: yes\nDoes what was asked: yes\n").verdict, "clean");
  assert.equal(v("Looks fine.\nDoes what was asked: yes\nSound: yes\n").verdict, "clean");
  assert.equal(v("Does what was asked: maybe\nSound: yes\n").verdict, "invalid");
  assert.equal(v("").verdict, "invalid");
  assert.equal(
    v("# Review: t1\n\nDoes what was asked: yes. The diff adds the\nline the task names.\nSound: yes. The check passes.\n\n## Blocking findings\n").verdict,
    "clean",
  );
  assert.equal(
    v("# Review: t1\n\nDiff: `git diff a...b`\nTask: t1.md\n\n## Verdict\n\nDoes what was asked: yes, as specified.\nSound: yes, both gates pass.\n\n**Clean.**\n").verdict,
    "clean",
  );
  assert.equal(v("Does what was asked: yes\na\nb\nc\nd\ne\nSound: yes\n").verdict, "invalid");
  assert.equal(v("Does what was asked: yes\n\n## Notes\n\nSound: yes\n").verdict, "invalid");
  const missing = gate("verdict", path.join(tmp, "absent.md"));
  assert.equal(missing.status, 0);
  assert.equal(missing.json.verdict, "invalid");
}

// diagnosis: the action block from the first `action:` line to the next
// heading, checked against --allow; fix and replan need a brief.
{
  const d = (text, ...flags) => gate("diagnosis", write("diagnosis.md", text), ...flags).json;
  assert.deepEqual(
    d("# Diagnosis\n\naction: replan\nreason: stage-test.sh belongs to another task.\nowns: `tests/a.sh`, ./b.nix\n\n## Brief\n\nOwn the test too.\n"),
    { ok: true, action: "replan", reason: "stage-test.sh belongs to another task.", verdict: null, owns: ["tests/a.sh", "b.nix"], brief: true },
  );
  const cont = d("action: continue\nreason: the verdict sits under a heading.\nverdict: clean\n", "--allow", "continue,decide", "--verdict", "yes");
  assert.equal(cont.ok, true);
  assert.equal(cont.verdict, "clean");
  assert.equal(d("action: continue\nreason: r\n", "--verdict", "yes").problem, "action continue needs a verdict line");
  assert.equal(d("action: fix\nreason: r\n\n## Brief\n\n## Notes\nx\n").problem, "action fix needs a ## Brief section");
  assert.match(d("action: replan\nreason: r\n\n## Brief\nx\n", "--allow", "continue,decide").problem, /not allowed/);
  assert.equal(d("action: shrug\nreason: r\n").problem, "unknown action shrug");
  assert.equal(d("action: decide\n").problem, "no reason line");
  assert.equal(d("Nothing to see.\n").problem, "no action line");
  assert.equal(d("action: decide\nreason: pick one\nowns: none\n").owns.length, 0);
  assert.equal(d("action: retry\n\n## Why\nreason: late\n").problem, "no reason line");
  assert.equal(gate("diagnosis", path.join(tmp, "absent.md")).json.problem, "file missing");
}

// angles: bullets of `- id | question`; repeats, bad ids and prose are ignored.
{
  const f = write(
    "angles.md",
    [
      "# Angles",
      "- api | What does the API return for an empty page?",
      "* limits-2 | What are the rate limits? | with a bar",
      "- api | duplicate id, dropped",
      "- bad id | spaces in the id are not an id",
      "- | no id",
      "- noquestion |",
      "prose | with a bar",
    ].join("\n"),
  );
  const r = gate("angles", f);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {
    ok: true,
    angles: [
      { id: "api", question: "What does the API return for an empty page?" },
      { id: "limits-2", question: "What are the rate limits? | with a bar" },
    ],
  });
  assert.equal(gate("angles", write("none.md", "nothing here\n")).json.ok, false);
  const missing = gate("angles", path.join(tmp, "absent.md"));
  assert.equal(missing.status, 0);
  assert.equal(missing.json.ok, false);
}

// gaps: only the bullets under `## Open gaps`; the verdict rides along.
{
  const review = [
    "Does what was asked: partly, two claims lack a source.",
    "Sound: yes, quotes spot-checked.",
    "",
    "## Blocking",
    "- not-a-gap | this bullet is outside the section",
    "",
    "## Open gaps",
    "- pricing | What does the paid tier cost per seat?",
    "- sla | Is there an uptime guarantee?",
    "",
    "## Evidence",
    "- also-not | outside again",
  ].join("\n");
  const r = gate("gaps", write("review.md", review));
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {
    ok: true,
    angles: [
      { id: "pricing", question: "What does the paid tier cost per seat?" },
      { id: "sla", question: "Is there an uptime guarantee?" },
    ],
    asked: "partly",
    sound: "yes",
    clean: false,
    verdict: "needs-work",
  });
  const none = gate("gaps", write("review.md", "Does what was asked: yes\nSound: yes\n\n## Open gaps\nnone\n"));
  assert.equal(none.json.ok, true);
  assert.deepEqual(none.json.angles, []);
  assert.equal(none.json.clean, true);
  const noSection = gate("gaps", write("review.md", "Does what was asked: yes\nSound: yes\n"));
  assert.deepEqual(noSection.json.angles, []);
  const bad = gate("gaps", write("review.md", "Looks fine.\n## Open gaps\n- x | y\n"));
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.verdict, "invalid");
  assert.deepEqual(bad.json.angles, [{ id: "x", question: "y" }]);
  assert.equal(gate("gaps", path.join(tmp, "absent.md")).json.ok, false);
}

// plan: tasks parsed from their headers, estimates from the sizing file, and
// the oversize, overlap, cycle and missing findings.
{
  const repo = dir();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/a.txt"), "x".repeat(4000));
  fs.writeFileSync(path.join(repo, "src/b.txt"), "y".repeat(8000));
  const sizing = write("sizing.json", JSON.stringify({ roles: { implementer: { base: 1000, k_read: 2, growth_p90: 500 } } }));
  const base = { id: "t1", owns: "src/a.txt", reads: "src/b.txt", check: "nix eval .#x", depends: "none" };
  const header = (h) =>
    Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  const task = (h, body = "Change it.\n") => `${header(h)}\n\n# Body\n${body}`;
  const mkPlan = (files, withPlan = true) => {
    const d = dir();
    if (withPlan) fs.writeFileSync(path.join(d, "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(d, "tasks"));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, "tasks", `${name}.md`), text);
    return d;
  };
  const planGate = (d, ...extra) => gate("plan", d, "--repo", repo, "--sizing", sizing, ...extra);

  const t2 = { id: "t2", owns: "new/c.txt", reads: "src/b.txt", check: "statix check new/c.nix", depends: "t1", research: "Which flag does tool x 2.0 use to set the cache dir?" };
  const cleanDir = mkPlan({ t1: task(base), t2: task(t2) });
  const clean = planGate(cleanDir);
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.json, {
    ok: true,
    tasks: [
      { id: "t1", file: path.join(cleanDir, "tasks", "t1.md"), owns: ["src/a.txt"], reads: ["src/b.txt"], check: "nix eval .#x", depends: [], research: "", est: 7500 },
      { id: "t2", file: path.join(cleanDir, "tasks", "t2.md"), owns: ["new/c.txt"], reads: ["src/b.txt"], check: "statix check new/c.nix", depends: ["t1"], research: "Which flag does tool x 2.0 use to set the cache dir?", est: 5500 },
    ],
    oversize: [],
    overlaps: [],
    missing: [],
    cycles: [],
  });

  const over = planGate(mkPlan({ t1: task(base), t2: task(t2) }), "--limit", "7000");
  assert.deepEqual(over.json.oversize, ["t1"]);
  assert.equal(over.json.ok, false);
  assert.deepEqual(planGate(mkPlan({ t1: task(base) }), "--limit", "7500").json.oversize, []);
  assert.equal(gate("plan", mkPlan({ t1: task(base) }), "--limit", "x").status, 2);

  const same = planGate(mkPlan({ t1: task(base), t2: task({ ...t2, owns: "new/c.txt, src/a.txt" }) }));
  assert.deepEqual(same.json.overlaps, [["t1", "t2", "src/a.txt"]]);
  assert.equal(same.json.ok, false);

  const nested = planGate(mkPlan({ t1: task({ ...base, owns: "src/" }), t2: task({ ...t2, owns: "./src/a.txt" }) }));
  assert.deepEqual(nested.json.overlaps, [["t1", "t2", "src/a.txt"]]);
  assert.deepEqual(nested.json.tasks.map((t) => t.owns), [["src"], ["src/a.txt"]]);
  const siblings = planGate(mkPlan({ t1: task({ ...base, owns: "src/a.txt" }), t2: task({ ...t2, owns: "src/a.txt.bak" }) }));
  assert.deepEqual(siblings.json.overlaps, []);
  const readsOwnedDir = planGate(mkPlan({ t1: task({ ...base, owns: "gen" }), t2: task({ ...t2, reads: "gen/out.txt" }) }));
  assert.deepEqual(readsOwnedDir.json.missing, []);

  const loop = planGate(mkPlan({ t1: task({ ...base, depends: "t2" }), t2: task({ ...t2, depends: "t1" }) }));
  assert.deepEqual(loop.json.cycles, [["t1", "t2", "t1"]]);
  assert.equal(loop.json.ok, false);
  assert.deepEqual(planGate(mkPlan({ t1: task({ ...base, depends: "t1" }) })).json.cycles, [["t1", "t1"]]);

  const unknown = planGate(mkPlan({ t1: task({ ...base, depends: "t9" }) }));
  assert.deepEqual(unknown.json.missing, ["t1: depends on unknown task t9"]);
  assert.deepEqual(unknown.json.cycles, []);
  assert.equal(unknown.json.ok, false);

  const { check: _check, ...noCheck } = base;
  const nc = planGate(mkPlan({ t1: task(noCheck) }));
  assert.deepEqual(nc.json.missing, ["t1: check"]);
  assert.equal(nc.json.tasks[0].check, "");
  assert.equal(nc.json.ok, false);
  assert.deepEqual(planGate(mkPlan({ t1: task({ ...base, check: "" }) })).json.missing, ["t1: check"]);

  const wrong = planGate(
    mkPlan({
      t1: task({ ...base, id: "other", owns: "none", reads: "`src/nope.txt`" }),
      t2: task({ ...t2, reads: "new/c.txt" }),
    }),
  );
  assert.deepEqual(wrong.json.missing, [
    "t1: id must be the file name",
    "t1: owns",
    "t1: reads src/nope.txt, which does not exist",
  ]);

  const created = planGate(mkPlan({ t1: task({ ...base, owns: "brand/new.txt", reads: "none" }) }));
  assert.equal(created.json.tasks[0].est, 1500);
  assert.deepEqual(created.json.tasks[0].reads, []);
  assert.equal(planGate(mkPlan({ t1: task({ ...base, owns: "src", reads: "none" }) })).json.tasks[0].est, 7500);

  const research = (value) => planGate(mkPlan({ t1: task({ ...base, research: value }) })).json.tasks[0].research;
  assert.equal(research("none"), "");
  assert.equal(research("None"), "");
  assert.equal(research(""), "");
  assert.equal(research("Does lib y 3.1 accept a timeout option?"), "Does lib y 3.1 accept a timeout option?");
  assert.equal(planGate(mkPlan({ t1: task(base) })).json.tasks[0].research, "");
  const thinkingIgnored = planGate(mkPlan({ t1: task({ ...base, thinking: "high" }) }));
  assert.equal(thinkingIgnored.json.ok, true);
  assert.equal("thinking" in thinkingIgnored.json.tasks[0], false);

  const loose = "\n\n" + task(base, "check: not a header\n");
  const parsed = planGate(mkPlan({ t1: loose }));
  assert.equal(parsed.json.tasks[0].check, "nix eval .#x");
  assert.equal(parsed.json.ok, true);

  const empty = planGate(mkPlan({}, false));
  assert.equal(empty.status, 0);
  assert.deepEqual(empty.json.missing, ["plan.md", "no tasks"]);
  assert.equal(empty.json.ok, false);
  assert.deepEqual(planGate(path.join(tmp, "absent")).json.missing, ["plan.md", "no tasks"]);

  // Without --sizing the file under $HOME is used, then built-in defaults.
  const withHome = (home, d) => {
    const r = spawnSync(process.execPath, [script, "plan", d, "--repo", repo], { encoding: "utf8", env: { ...process.env, HOME: home } });
    return JSON.parse(r.stdout);
  };
  const home = dir();
  const d = mkPlan({ t1: task(base) });
  assert.equal(withHome(home, d).tasks[0].est, 20000);
  fs.mkdirSync(path.join(home, ".pi/agent/recipes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi/agent/recipes/sizing.json"), JSON.stringify({ roles: { implementer: { base: 2000, growth_p90: 1000 } } }));
  assert.equal(withHome(home, d).tasks[0].est, 2000 + 3000 + 1000);
  assert.equal(gate("plan", d, "--repo", repo, "--sizing", path.join(tmp, "absent.json")).status, 1);
}

// task and integrate: run against real git worktrees.
{
  const env = { ...process.env, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const gateIn = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
    return { status: r.status, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const source = dir();
  git(source, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(source, "a.txt"), "a\n");
  fs.writeFileSync(path.join(source, "b.txt"), "b\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "init");
  const main = git(source, "rev-parse", "HEAD");

  const worktree = (branch, where = path.join(dir(), "wt")) => {
    git(source, "worktree", "add", "-q", "-b", branch, where, "main");
    return where;
  };
  const commit = (wt, file, text) => {
    fs.writeFileSync(path.join(wt, file), text);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", `change ${file}`);
  };
  const report = (text) => write("report.md", text);
  const taskGate = (wt, rep, ...rest) => gateIn(wt, "task", rep, "--repo", source, ...rest);

  // A clean task: one commit inside owns, green check.
  const wt1 = worktree("pi/t1");
  commit(wt1, "a.txt", "a2\n");
  const good = taskGate(wt1, report("done\nthe detail"), "--check", "echo fine", "--owns", "a.txt");
  assert.equal(good.status, 0);
  assert.equal(good.json.ok, true);
  assert.equal(good.json.reason, "");
  assert.equal(good.json.branch, "pi/t1");
  assert.equal(good.json.base, main);
  assert.equal(good.json.commits, 1);
  assert.deepEqual(good.json.files, ["a.txt"]);
  assert.deepEqual(good.json.outside, []);
  assert.equal(good.json.clean, true);
  assert.deepEqual(good.json.report, { status: "done", why: "" });
  assert.equal(good.json.check.exit, 0);
  assert.equal(good.json.check.tail.trim(), "fine");
  assert.equal(fs.realpathSync(good.json.worktree), fs.realpathSync(wt1));
  assert.equal(good.json.head, git(wt1, "rev-parse", "HEAD"));

  // Concerns still pass; a directory in owns covers the files below it.
  fs.mkdirSync(path.join(wt1, "sub"));
  commit(wt1, "sub/x.txt", "x\n");
  const dirOwned = taskGate(wt1, report("**done, concerns**\nsee below"), "--check", "true", "--owns", "a.txt,sub/");
  assert.equal(dirOwned.json.ok, true);
  assert.equal(dirOwned.json.report.status, "done, concerns");
  assert.deepEqual(dirOwned.json.files, ["a.txt", "sub/x.txt"]);

  // A red check names its exit status and output.
  const red = taskGate(wt1, report("done"), "--check", "echo broke >&2; exit 3", "--owns", "a.txt,sub");
  assert.equal(red.status, 0);
  assert.equal(red.json.ok, false);
  assert.equal(red.json.check.exit, 3);
  assert.match(red.json.reason, /^check failed \(exit 3\): broke/);

  // Changes outside owns are listed.
  commit(wt1, "b.txt", "b2\n");
  const outside = taskGate(wt1, report("done"), "--check", "true", "--owns", "a.txt,sub");
  assert.equal(outside.json.ok, false);
  assert.deepEqual(outside.json.outside, ["b.txt"]);
  assert.equal(outside.json.reason, "changed files outside owns: b.txt");

  // Uncommitted work is not finished work.
  fs.writeFileSync(path.join(wt1, "a.txt"), "dirty\n");
  const dirty = taskGate(wt1, report("done"), "--check", "true");
  assert.equal(dirty.json.ok, false);
  assert.equal(dirty.json.clean, false);
  assert.equal(dirty.json.reason, "uncommitted changes in the worktree");

  // No commits at all.
  const wt0 = worktree("pi/t0");
  const none = taskGate(wt0, report("done"), "--check", "true");
  assert.equal(none.json.ok, false);
  assert.equal(none.json.commits, 0);
  assert.equal(none.json.reason, "no commits on the branch");

  // A blocked or failed report skips the check and carries its reason.
  const blocked = taskGate(wt0, report("blocked: baseline failing\nmore"), "--check", "touch ran.txt");
  assert.equal(blocked.json.ok, false);
  assert.deepEqual(blocked.json.report, { status: "blocked", why: "baseline failing" });
  assert.equal(blocked.json.check.exit, null);
  assert.equal(blocked.json.reason, "report blocked: baseline failing");
  assert.equal(fs.existsSync(path.join(wt0, "ran.txt")), false);
  assert.equal(taskGate(wt0, report("failed: cannot parse"), "--check", "true").json.report.status, "failed");
  assert.equal(taskGate(wt0, report("I did the thing"), "--check", "true").json.report.status, "invalid");
  assert.equal(taskGate(wt0, path.join(tmp, "absent.md"), "--check", "true").json.report.status, "missing");

  // Dependency branches merged into the task are not part of its own diff.
  const dep = worktree("pi/dep");
  commit(dep, "d.txt", "d\n");
  const wt2 = worktree("pi/t2");
  git(wt2, "merge", "-q", "--no-ff", "--no-edit", "pi/dep");
  commit(wt2, "a.txt", "a3\n");
  const merged = taskGate(wt2, report("done"), "--check", "true", "--owns", "a.txt");
  assert.equal(merged.json.ok, true);
  assert.equal(merged.json.commits, 1);
  assert.deepEqual(merged.json.files, ["a.txt"]);
  assert.equal(merged.json.base, git(wt2, "rev-parse", "HEAD~1"));

  // Usage: task needs a check; without --repo there is no base.
  assert.equal(gateIn(wt2, "task", report("done")).status, 2);
  const noRepo = gateIn(wt2, "task", report("done"), "--check", "true");
  assert.equal(noRepo.json.ok, false);
  assert.equal(noRepo.json.reason, "no base commit: pass --repo of the source checkout");

  // integrate: branches merged in order, pull request text and heavy result.
  const integ = (d, branch = "implement/x") => {
    git(source, "worktree", "add", "-q", "-b", branch, path.join(d, "integration"), "main");
    return path.join(d, "integration");
  };
  const d1 = dir();
  const iw = integ(d1);
  git(iw, "merge", "-q", "--no-edit", "pi/t2");
  const partial = gate("integrate", d1, "--tasks", "t2:pi/t2,dep:pi/dep", "--branch", "implement/x");
  assert.equal(partial.status, 0);
  assert.equal(partial.json.ok, false);
  assert.equal(partial.json.branch, "implement/x");
  assert.deepEqual(partial.json.merged, ["t2", "dep"]);
  assert.deepEqual(partial.json.reasons, ["pr.md missing or empty", "heavy checks: not recorded"]);

  commit(wt1, "a.txt", "a4\n");
  git(wt1, "branch", "-q", "pi/t3");
  const three = gate("integrate", d1, "--tasks", "t2:pi/t2,t3:pi/t3,dep:pi/dep");
  assert.deepEqual(three.json.merged, ["t2", "dep"]);
  assert.deepEqual(three.json.unmerged, ["t3"]);
  assert.equal(three.json.reasons[0], "not merged: t3");

  fs.writeFileSync(path.join(d1, "pr.md"), "Title line\n\nWhat and why.\n");
  fs.writeFileSync(path.join(d1, "heavy.md"), "pass\nflake check output\n");
  const whole = gate("integrate", d1, "--tasks", "t2:pi/t2,dep:pi/dep", "--branch", "implement/x");
  assert.equal(whole.json.ok, true);
  assert.deepEqual(whole.json.reasons, []);
  assert.equal(whole.json.heavy_check, "pass");
  assert.equal(whole.json.pr_text, "Title line\n\nWhat and why.");
  assert.equal(whole.json.head, git(iw, "rev-parse", "HEAD"));

  const wrongBranch = gate("integrate", d1, "--tasks", "t2:pi/t2", "--branch", "implement/other");
  assert.equal(wrongBranch.json.ok, false);
  assert.match(wrongBranch.json.reasons[0], /^integration worktree is on implement\/x, not implement\/other$/);

  fs.writeFileSync(path.join(d1, "heavy.md"), "**fail**: flake check red\n");
  assert.equal(gate("integrate", d1, "--tasks", "t2:pi/t2").json.heavy_check, "fail: flake check red");
  assert.equal(gate("integrate", d1, "--tasks", "t2:pi/t2").json.ok, false);
  fs.writeFileSync(path.join(d1, "heavy.md"), "none\nthe plan names no heavy check\n");
  assert.equal(gate("integrate", d1, "--tasks", "t2:pi/t2").json.ok, true);

  const absent = gate("integrate", dir(), "--tasks", "t2:pi/t2");
  assert.equal(absent.status, 0);
  assert.equal(absent.json.ok, false);
  assert.equal(absent.json.branch, null);
  assert.deepEqual(absent.json.unmerged, ["t2"]);
  assert.equal(absent.json.reasons[0], "no integration worktree");
}

// integrate --tidy: after a passing check, merged tasks lose their worktree and
// branch; an unmerged branch, a dirty worktree and a failing check keep them.
{
  const env = { ...process.env, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const gateEnv = (...args) => {
    const r = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const repo = dir();
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "f\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const task = (b, file) => {
    const wt = path.join(dir(), "wt");
    git(repo, "worktree", "add", "-q", "-b", b, wt, "main");
    fs.writeFileSync(path.join(wt, file), b + "\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", b);
    return wt;
  };
  const wa = task("pi/a", "a.txt");
  const wb = task("pi/b", "b.txt");
  const wc = task("pi/c", "c.txt");
  fs.writeFileSync(path.join(wc, "scratch.txt"), "left behind\n");
  const plan = dir();
  const iw = path.join(plan, "integration");
  git(repo, "worktree", "add", "-q", "-b", "implement/p", iw, "main");
  git(iw, "merge", "-q", "--no-edit", "pi/a");
  git(iw, "merge", "-q", "--no-edit", "pi/c");
  fs.writeFileSync(path.join(plan, "heavy.md"), "none\n");

  const notOk = gateEnv("integrate", plan, "--tasks", "a:pi/a,c:pi/c", "--branch", "implement/p", "--tidy", "yes");
  assert.equal(notOk.ok, false);
  assert.equal(notOk.tidied, undefined);
  assert.ok(fs.existsSync(wa));

  fs.writeFileSync(path.join(plan, "pr.md"), "Title\n");
  const r = gateEnv("integrate", plan, "--tasks", "a:pi/a,c:pi/c", "--branch", "implement/p", "--tidy", "yes");
  assert.equal(r.ok, true);
  assert.deepEqual(r.tidied, ["a"]);
  assert.equal(r.tidy_problems.length, 1);
  assert.match(r.tidy_problems[0], /^c: worktree .* kept: /);
  assert.ok(!fs.existsSync(wa));
  assert.ok(fs.existsSync(wb) && fs.existsSync(wc));
  const branches = git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
  assert.deepEqual(branches, ["implement/p", "main", "pi/b", "pi/c"]);
  assert.ok(!git(repo, "worktree", "list").includes(wa));

  const plain = gateEnv("integrate", plan, "--tasks", "c:pi/c", "--branch", "implement/p");
  assert.equal(plain.tidied, undefined);

  // The same command again, as when the integrating child ran it first: the
  // tidied branch counts as merged by its recorded commit.
  const again = gateEnv("integrate", plan, "--tasks", "a:pi/a,c:pi/c", "--branch", "implement/p", "--tidy", "yes");
  assert.equal(again.ok, true, again.reasons.join("; "));
  assert.deepEqual(again.merged, ["a", "c"]);
  assert.deepEqual(again.tidied, ["a"]);
  assert.equal(again.tidy_problems.length, 1);

  // A merged branch that is gone without a record is not merged.
  git(iw, "merge", "-q", "--no-edit", "pi/b");
  git(repo, "worktree", "remove", wb);
  git(repo, "branch", "-D", "pi/b");
  const gone = gateEnv("integrate", plan, "--tasks", "a:pi/a,b:pi/b", "--branch", "implement/p");
  assert.deepEqual(gone.unmerged, ["b"]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-gate: all assertions passed");
