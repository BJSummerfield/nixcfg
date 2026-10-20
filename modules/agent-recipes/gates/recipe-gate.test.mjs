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

// verdict: the two first lines decide; anything missing is invalid.
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
  assert.equal(v("Looks fine.\nDoes what was asked: yes\nSound: yes\n").verdict, "invalid");
  assert.equal(v("Does what was asked: maybe\nSound: yes\n").verdict, "invalid");
  assert.equal(v("").verdict, "invalid");
  const missing = gate("verdict", path.join(tmp, "absent.md"));
  assert.equal(missing.status, 0);
  assert.equal(missing.json.verdict, "invalid");
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
  const base = { id: "t1", owns: "src/a.txt", reads: "src/b.txt", check: "nix eval .#x", depends: "none", thinking: "medium" };
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

  const t2 = { id: "t2", owns: "new/c.txt", reads: "src/b.txt", check: "statix check new/c.nix", depends: "t1", thinking: "xhigh" };
  const cleanDir = mkPlan({ t1: task(base), t2: task(t2) });
  const clean = planGate(cleanDir);
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.json, {
    ok: true,
    tasks: [
      { id: "t1", file: path.join(cleanDir, "tasks", "t1.md"), owns: ["src/a.txt"], reads: ["src/b.txt"], check: "nix eval .#x", depends: [], thinking: "medium", est: 7500 },
      { id: "t2", file: path.join(cleanDir, "tasks", "t2.md"), owns: ["new/c.txt"], reads: ["src/b.txt"], check: "statix check new/c.nix", depends: ["t1"], thinking: "xhigh", est: 5500 },
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
      t1: task({ ...base, id: "other", owns: "none", reads: "`src/nope.txt`", thinking: "high" }),
      t2: task({ ...t2, reads: "new/c.txt" }),
    }),
  );
  assert.deepEqual(wrong.json.missing, [
    "t1: id must be the file name",
    "t1: owns",
    "t1: thinking must be medium or xhigh",
    "t1: reads src/nope.txt, which does not exist",
  ]);

  const created = planGate(mkPlan({ t1: task({ ...base, owns: "brand/new.txt", reads: "none" }) }));
  assert.equal(created.json.tasks[0].est, 1500);
  assert.deepEqual(created.json.tasks[0].reads, []);
  assert.equal(planGate(mkPlan({ t1: task({ ...base, owns: "src", reads: "none" }) })).json.tasks[0].est, 7500);

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-gate: all assertions passed");
