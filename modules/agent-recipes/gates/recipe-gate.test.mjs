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

// paths: locator bullets with optional line ranges; duplicates by path+range dropped.
{
  const f = write("p.md", "## a1\n- src/a.js:10-20 | primary | the loop\n- src/b.js | secondary | whole file\n- src/a.js:10-20 | secondary | again\n- src/a.js:30-40 | x\n## a2\n- src/c.js | weird | y | z\nprose\n");
  const r = gate("paths", f);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.paths, [
    { path: "src/a.js", range: { start: 10, end: 20 }, why: "the loop", kind: "primary" },
    { path: "src/b.js", range: null, why: "whole file", kind: "secondary" },
    { path: "src/a.js", range: { start: 30, end: 40 }, why: "", kind: "secondary" },
    { path: "src/c.js", range: null, why: "y | z", kind: "secondary" },
  ]);
  const empty = gate("paths", write("p.md", "## a1\nnothing\n"));
  assert.equal(empty.json.ok, false);
  assert.deepEqual(empty.json.paths, []);
  assert.equal(gate("paths", path.join(tmp, "absent.md")).json.ok, false);
}

// extract from a repository file: quotes must appear in the named file and range.
{
  const repo = dir();
  // "last line" sits past the range margin of the Range: 1-1 case below.
  const js = ["line one", "function go() {", "  return 1;", "}", ...Array.from({ length: 10 }, () => "pad"), "last line"].join("\n") + "\n";
  fs.writeFileSync(path.join(repo, "s.js"), js);
  const good = gate("extract", write("e.md", "File: s.js\nRange: 2-4\n\n> function go() {\n>   return 1;\n\n> }\n"), "--repo", repo);
  assert.equal(good.json.ok, true);
  assert.equal(good.json.quotes, 2);
  assert.deepEqual(good.json.missing, []);
  const bad = gate("extract", write("e.md", "File: s.js\n\n> function go() {\n\n> not in the file\n"), "--repo", repo);
  assert.equal(bad.json.ok, false);
  assert.deepEqual(bad.json.missing, ["not in the file"]);
  const outside = gate("extract", write("e.md", "File: s.js\nRange: 1-1\n\n> last line\n"), "--repo", repo);
  assert.equal(outside.json.ok, false);
  const nofile = gate("extract", write("e.md", "File: gone.js\n\n> x\n"), "--repo", repo);
  assert.equal(nofile.json.ok, false);
}

// A locator's range is approximate: quotes within the margin of it pass; only quotes far outside it, or absent from the file, are missing.
{
  const repo = dir();
  const abs = path.join(repo, "page.md");
  fs.writeFileSync(abs, Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
  const ranged = (quote) => gate("extract", write("e.md", `File: ${abs}\nRange: 11-28\n\n${quote}\n`));
  const justBefore = ranged("> row 10");
  assert.equal(justBefore.json.ok, true);
  assert.deepEqual(justBefore.json.missing, []);
  assert.equal(ranged("> row 31").json.ok, true);
  const far = ranged("> row 78");
  assert.equal(far.json.ok, false);
  assert.deepEqual(far.json.missing, ["row 78"]);
  const absent = ranged("> invented row");
  assert.equal(absent.json.ok, false);
  assert.deepEqual(absent.json.missing, ["invented row"]);
}

// extract shaped as the extractor prompt describes: File, Range, Source, then quotes.
{
  const repo = dir();
  fs.writeFileSync(path.join(repo, "s.js"), "line one\nfunction go() {\n  return 1;\n}\n");
  const abs = path.join(repo, "s.js");
  const shaped = (quote) => `File: ${abs}\nRange: 1-4\nSource: ${abs}\n\ns.js:2-3\n${quote}\n`;
  const bad = gate("extract", write("e.md", shaped("> invented text not in the file")));
  assert.equal(bad.json.ok, false);
  assert.deepEqual(bad.json.missing, ["invented text not in the file"]);
  const good = gate("extract", write("e.md", shaped("> function go() {\n>   return 1;")));
  assert.equal(good.json.ok, true);
  const gone = gate("extract", write("e.md", "File: /nonexistent/x.js\n\n> x\n"));
  assert.equal(gone.json.ok, false);
  assert.equal(gone.json.reason, "named file missing");
  const web = gate("extract", write("e.md", "Source: https://x.test\n\n> a\n\nFile: nothing.js\n"));
  assert.equal(web.json.ok, true);
  const single = gate("paths", write("p.md", "- s.js:42 | primary | w\n"));
  assert.deepEqual(single.json.paths[0].range, { start: 42, end: 42 });
  assert.equal(single.json.paths[0].path, "s.js");
}

// A File header with a parenthesised suffix still names the file; its ranges apply when no Range line is given.
{
  const repo = dir();
  const body = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n");
  const abs = path.join(repo, "page.md");
  fs.writeFileSync(abs, body + "\n");
  const suffixed = (quotes, extra = "") => write("e.md", `File: ${abs} (lines 3-5, 20-22)\n${extra}Source: ${abs}\n\n${quotes}\n`);
  const good = gate("extract", suffixed("> row 4\n\n> row 21"));
  assert.equal(good.json.ok, true);
  assert.equal(good.json.file, abs);
  assert.deepEqual(good.json.missing, []);
  const outside = gate("extract", suffixed("> row 60"));
  assert.equal(outside.json.ok, false);
  assert.deepEqual(outside.json.missing, ["row 60"]);
  const ruled = gate("extract", suffixed("> row 10", "Range: 9-11\n"));
  assert.equal(ruled.json.ok, true);
  const words = gate("extract", write("e.md", `File: ${abs} lines 3-5\n\n> row 4\n`));
  assert.equal(words.json.ok, true);
  const gone = gate("extract", write("e.md", "File: /nonexistent/x.md (lines 1-2)\n\n> x\n"));
  assert.equal(gone.json.reason, "named file missing");
  assert.equal(gone.json.file, "/nonexistent/x.md");
  const spaced = path.join(repo, "my page.md");
  fs.writeFileSync(spaced, body + "\n");
  assert.equal(gate("extract", write("e.md", `File: ${spaced}\n\n> row 4\n`)).json.ok, true);
}

// A blockquote's first line may be only a location, and its code lines may be
// wrapped in backticks or set off by a fence; none of that is the text matched
// in the file, so the same passage passes and only invented code fails.
{
  const repo = dir();
  const abs = path.join(repo, "calc.js");
  fs.writeFileSync(abs, 'export const FIXTURE_TAG = "tinycalc-q7v2";\nline two\nline three\n');

  // The live shape that used to fail: a location line, a blank >, one backticked line.
  const sample = gate("extract", write("e.md", `File: ${abs}\n\n> calc.js:1\n>\n> \`export const FIXTURE_TAG = "tinycalc-q7v2";\`\n`), "--repo", repo);
  assert.equal(sample.status, 0);
  assert.equal(sample.json.ok, true, JSON.stringify(sample.json));
  assert.equal(sample.json.quotes, 1);
  assert.deepEqual(sample.json.missing, []);

  // A start-end location with several backticked lines, still within the range.
  const ranged = gate("extract", write("e.md", `File: ${abs}\nRange: 1-3\n\n> calc.js:1-3\n>\n> \`export const FIXTURE_TAG = "tinycalc-q7v2";\`\n> \`line two\`\n> \`line three\`\n`), "--repo", repo);
  assert.equal(ranged.json.ok, true, JSON.stringify(ranged.json));
  assert.deepEqual(ranged.json.missing, []);

  // A fenced block inside the quote drops its fence lines but keeps its body.
  const fenced = gate("extract", write("e.md", `File: ${abs}\nRange: 1-3\n\n> calc.js:1-3\n>\n> \`\`\`js\n> line two\n> line three\n> \`\`\`\n`), "--repo", repo);
  assert.equal(fenced.json.ok, true, JSON.stringify(fenced.json));
  assert.deepEqual(fenced.json.missing, []);

  // A location line does not rescue invented code.
  const invented = gate("extract", write("e.md", `File: ${abs}\n\n> calc.js:1\n>\n> \`no such line anywhere\`\n`), "--repo", repo);
  assert.equal(invented.json.ok, false);
  assert.deepEqual(invented.json.missing, ["no such line anywhere"]);
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
  assert.equal(v("handoff: half done\nDoes what was asked: yes\nSound: yes\n").verdict, "invalid");
  assert.equal(v("handoff: half done\nDoes what was asked: yes\nSound: yes\n").clean, false);
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
    { ok: true, action: "replan", reason: "stage-test.sh belongs to another task.", verdict: null, owns: ["tests/a.sh", "b.nix"], brief: true, question: "" },
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

  // Dependency branches merged into the task are outside its own diff when --base names the merge.
  const dep = worktree("pi/dep");
  commit(dep, "d.txt", "d\n");
  const wt2 = worktree("pi/t2");
  git(wt2, "merge", "-q", "--no-ff", "--no-edit", "pi/dep");
  commit(wt2, "a.txt", "a3\n");
  const merged = taskGate(wt2, report("done"), "--check", "true", "--owns", "a.txt", "--base", git(wt2, "rev-parse", "HEAD~1"));
  assert.equal(merged.json.ok, true);
  assert.equal(merged.json.commits, 1);
  assert.deepEqual(merged.json.files, ["a.txt"]);
  assert.equal(merged.json.base, git(wt2, "rev-parse", "HEAD~1"));

  // A handoff report is never passing and runs no check.
  const wtH = worktree("pi/handoff");
  commit(wtH, "a.txt", "half\n");
  const handoff = taskGate(wtH, report("handoff: half done\nthe rest"), "--check", "echo ran");
  assert.equal(handoff.json.ok, false);
  assert.deepEqual(handoff.json.report, { status: "handoff", why: "half done" });
  assert.equal(handoff.json.reason, "report handoff: half done");
  assert.equal(handoff.json.commits, 1);
  assert.ok(handoff.json.head);
  assert.equal(handoff.json.check.exit, null);

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

// task and integrate: commits must be made with the configured git identity.
{
  const env = {
    ...process.env,
    HOME: tmp,
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const gateIn = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
    return { status: r.status, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const report = (text) => write("report.md", text);
  // GIT_AUTHOR_* and GIT_COMMITTER_* outrank -c, so the override only takes
  // effect with them out of the environment.
  const overrideEnv = { ...env };
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete overrideEnv[k];
  const overrideCommit = (cwd, msg) => {
    const r = spawnSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@localhost", "commit", "-q", "-m", msg], {
      cwd,
      env: overrideEnv,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
  };

  const source = dir();
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "agent");
  git(source, "config", "user.email", "agent@example.com");
  fs.writeFileSync(path.join(source, "a.txt"), "a\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "init");

  // A branch whose commits use the configured identity passes.
  const wt = path.join(dir(), "wt");
  git(source, "worktree", "add", "-q", "-b", "pi/id", wt, "main");
  fs.writeFileSync(path.join(wt, "a.txt"), "a2\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "id");
  const ok = gateIn(wt, "task", report("done"), "--repo", source, "--check", "true", "--owns", "a.txt");
  assert.equal(ok.status, 0);
  assert.equal(ok.json.ok, true, ok.json.reason);
  assert.deepEqual(ok.json.identity, { expected: { name: "agent", email: "agent@example.com" }, mismatched: [], unreadable: false });

  // A commit made with an overridden identity fails and is listed.
  fs.writeFileSync(path.join(wt, "a.txt"), "a3\n");
  git(wt, "add", "-A");
  overrideCommit(wt, "wrong identity");
  const badSha = git(wt, "rev-parse", "--short", "HEAD");
  const bad = gateIn(wt, "task", report("done"), "--repo", source, "--check", "true", "--owns", "a.txt");
  assert.equal(bad.status, 0);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.check.exit, 0);
  assert.match(bad.json.reason, /^commits not made with the configured git identity agent <agent@example\.com>: /);
  assert.deepEqual(bad.json.identity.mismatched, [`${badSha} agent <agent@localhost>`]);
  assert.match(bad.json.reason, new RegExp(`${badSha} agent <agent@localhost>`));

  // A commit wrong only in user.name (the email is the configured one) fails.
  const nmWt = path.join(dir(), "wtnm");
  git(source, "worktree", "add", "-q", "-b", "pi/nm", nmWt, "main");
  fs.writeFileSync(path.join(nmWt, "n.txt"), "n\n");
  git(nmWt, "add", "-A");
  const nmCommit = spawnSync("git", ["-c", "user.name=wrongname", "commit", "-q", "-m", "wrong name"], {
    cwd: nmWt,
    env: overrideEnv,
    encoding: "utf8",
  });
  assert.equal(nmCommit.status, 0, nmCommit.stderr);
  const nmSha = git(nmWt, "rev-parse", "--short", "HEAD");
  const nm = gateIn(nmWt, "task", report("done"), "--repo", source, "--check", "true", "--owns", "n.txt");
  assert.equal(nm.status, 0);
  assert.equal(nm.json.ok, false, nm.json.reason);
  assert.match(nm.json.reason, new RegExp(`${nmSha} wrongname <agent@example\\.com>`));

  // A commit wrong only in the committer email fails even though the author is right.
  const ccWt = path.join(dir(), "wtcc");
  git(source, "worktree", "add", "-q", "-b", "pi/cc", ccWt, "main");
  fs.writeFileSync(path.join(ccWt, "cc.txt"), "cc\n");
  git(ccWt, "add", "-A");
  const ccCommit = spawnSync("git", ["commit", "-q", "-m", "wrong committer"], {
    cwd: ccWt,
    env: { ...env, GIT_COMMITTER_EMAIL: "agent@localhost" },
    encoding: "utf8",
  });
  assert.equal(ccCommit.status, 0, ccCommit.stderr);
  const ccSha = git(ccWt, "rev-parse", "--short", "HEAD");
  const cc = gateIn(ccWt, "task", report("done"), "--repo", source, "--check", "true", "--owns", "cc.txt");
  assert.equal(cc.status, 0);
  assert.equal(cc.json.ok, false, cc.json.reason);
  assert.match(cc.json.reason, new RegExp(`${ccSha} agent <agent@example\\.com>`));

  // A commit made with an empty email has a log line with no address; it must
  // be a mismatch, not an unparseable line that passes.
  const eeWt = path.join(dir(), "wtee");
  git(source, "worktree", "add", "-q", "-b", "pi/ee", eeWt, "main");
  fs.writeFileSync(path.join(eeWt, "ee.txt"), "ee\n");
  git(eeWt, "add", "-A");
  const eeCommit = spawnSync("git", ["-c", "user.email=", "commit", "-q", "-m", "empty email"], {
    cwd: eeWt,
    env: overrideEnv,
    encoding: "utf8",
  });
  assert.equal(eeCommit.status, 0, eeCommit.stderr);
  const eeSha = git(eeWt, "rev-parse", "--short", "HEAD");
  const ee = gateIn(eeWt, "task", report("done"), "--repo", source, "--check", "true", "--owns", "ee.txt");
  assert.equal(ee.status, 0);
  assert.equal(ee.json.ok, false, ee.json.reason);
  assert.deepEqual(ee.json.identity.mismatched, [`${eeSha} agent <>`]);

  // With no user.email configured the check is skipped.
  const unconfigured = dir();
  git(unconfigured, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(unconfigured, "a.txt"), "a\n");
  git(unconfigured, "add", "-A");
  git(unconfigured, "commit", "-q", "-m", "init");
  const wt2 = path.join(dir(), "wt2");
  git(unconfigured, "worktree", "add", "-q", "-b", "pi/noid", wt2, "main");
  fs.writeFileSync(path.join(wt2, "a.txt"), "x\n");
  git(wt2, "add", "-A");
  git(wt2, "commit", "-q", "-m", "noid");
  const skipped = gateIn(wt2, "task", report("done"), "--repo", unconfigured, "--check", "true", "--owns", "a.txt");
  assert.equal(skipped.status, 0);
  assert.equal(skipped.json.ok, true, skipped.json.reason);
  assert.deepEqual(skipped.json.identity, { expected: null, mismatched: [], unreadable: false });

  // integrate: fails when the integration branch holds such a commit, passes otherwise.
  const badid = path.join(dir(), "badid");
  git(source, "worktree", "add", "-q", "-b", "pi/badid", badid, "main");
  fs.writeFileSync(path.join(badid, "b.txt"), "b\n");
  git(badid, "add", "-A");
  overrideCommit(badid, "wrong identity");
  const badSha2 = git(badid, "rev-parse", "--short", "HEAD");
  const plan = dir();
  const pinned = gateIn(source, "pin", plan, "--repo", source);
  assert.equal(pinned.status, 0);
  assert.equal(pinned.json.ok, true, pinned.json.reason);
  const iw = path.join(plan, "integration");
  git(source, "worktree", "add", "-q", "-b", "implement/x", iw, "main");
  git(iw, "merge", "-q", "--no-edit", "pi/badid");
  fs.writeFileSync(path.join(plan, "pr.md"), "Title\n");
  fs.writeFileSync(path.join(plan, "heavy.md"), "none\n");
  const failed = gateIn(source, "integrate", plan, "--tasks", "bad:pi/badid", "--branch", "implement/x");
  assert.equal(failed.status, 0);
  assert.equal(failed.json.ok, false);
  const identityReason = failed.json.reasons.find((s) => s.startsWith("commits not made with the configured git identity"));
  assert.match(identityReason, new RegExp(`${badSha2} agent <agent@localhost>`));

  const goodid = path.join(dir(), "goodid");
  git(source, "worktree", "add", "-q", "-b", "pi/goodid", goodid, "main");
  fs.writeFileSync(path.join(goodid, "c.txt"), "c\n");
  git(goodid, "add", "-A");
  git(goodid, "commit", "-q", "-m", "good identity");
  // Main's own history is not the run's work: a commit on main by another
  // identity, made before the pin, must not fail integrate.
  fs.writeFileSync(path.join(source, "main.txt"), "main\n");
  git(source, "add", "-A");
  overrideCommit(source, "main history");
  const plan2 = dir();
  gateIn(source, "pin", plan2, "--repo", source);
  const iw2 = path.join(plan2, "integration");
  git(source, "worktree", "add", "-q", "-b", "implement/y", iw2, "main");
  git(iw2, "merge", "-q", "--no-edit", "pi/goodid");
  fs.writeFileSync(path.join(plan2, "pr.md"), "Title\n");
  fs.writeFileSync(path.join(plan2, "heavy.md"), "none\n");
  const passed = gateIn(source, "integrate", plan2, "--tasks", "good:pi/goodid", "--branch", "implement/y");
  assert.equal(passed.status, 0);
  assert.equal(passed.json.ok, true, passed.json.reasons.join("; "));
  assert.deepEqual(passed.json.reasons, []);

  // A pinned base the repository no longer holds cannot be logged; integrate
  // must say so instead of passing.
  const plan3 = dir();
  gateIn(source, "pin", plan3, "--repo", source);
  const ledger = JSON.parse(fs.readFileSync(path.join(plan3, "run.json"), "utf8"));
  ledger.base = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  fs.writeFileSync(path.join(plan3, "run.json"), JSON.stringify(ledger, null, 2) + "\n");
  const iw3 = path.join(plan3, "integration");
  git(source, "worktree", "add", "-q", "-b", "implement/z", iw3, "main");
  git(iw3, "merge", "-q", "--no-edit", "pi/goodid");
  fs.writeFileSync(path.join(plan3, "pr.md"), "Title\n");
  fs.writeFileSync(path.join(plan3, "heavy.md"), "none\n");
  const unreadable = gateIn(source, "integrate", plan3, "--tasks", "good:pi/goodid", "--branch", "implement/z");
  assert.equal(unreadable.status, 0);
  assert.equal(unreadable.json.ok, false, unreadable.json.reasons.join("; "));
  assert.ok(unreadable.json.reasons.some((s) => s.startsWith("commits could not be read: ")));
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


// pin, merge, abandon, task --base/--run, verdict --run and integrate --tidy
// clearing recorded worktrees, through the CLI.
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
  const repo = dir();
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const commit = (wt, file, text, msg = file) => {
    fs.writeFileSync(path.join(wt, file), text);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", msg);
  };
  const report = (text) => write("report.md", text);
  const readRun = (d) => JSON.parse(fs.readFileSync(path.join(d, "run.json"), "utf8"));

  // pin twice around a new commit returns the same base.
  const run = dir();
  const p1 = gateIn(repo, "pin", run, "--repo", repo);
  assert.equal(p1.json.ok, true);
  const base = git(repo, "rev-parse", "HEAD");
  assert.equal(p1.json.base, base);
  commit(repo, "later.txt", "later\n");
  const p2 = gateIn(repo, "pin", run, "--repo", repo);
  assert.equal(p2.json.base, base);
  assert.equal(p2.json.reused, true);

  // merge reports a conflict with its files, then ok after a hand resolution.
  const t1 = path.join(dir(), "t1");
  const t2 = path.join(dir(), "t2");
  git(repo, "worktree", "add", "-q", "-b", "pi/t1", t1, p1.json.base_ref);
  git(repo, "worktree", "add", "-q", "-b", "pi/t2", t2, p1.json.base_ref);
  commit(t1, "f.txt", "from t1\n");
  commit(t2, "f.txt", "from t2\n");
  const deps = path.join(dir(), "deps");
  const mergeArgs = ["merge", deps, "--dir", run, "--branch", "pi/deps", "--tips", "t1:pi/t1,t2:pi/t2", "--kind", "deps", "--id", "t3"];
  const m1 = gateIn(repo, ...mergeArgs);
  assert.equal(m1.status, 0);
  assert.equal(m1.json.ok, false);
  assert.deepEqual(m1.json.conflict, { id: "t2", files: ["f.txt"] });
  assert.deepEqual(m1.json.merged, ["t1"]);
  fs.writeFileSync(path.join(deps, "f.txt"), "both\n");
  git(deps, "add", "f.txt");
  git(deps, "commit", "-q", "--no-edit");
  const m2 = gateIn(repo, ...mergeArgs);
  assert.equal(m2.json.ok, true, m2.json.reason);
  assert.deepEqual(m2.json.resolved, [{ id: "t2", files: ["f.txt"] }]);
  assert.equal(gateIn(repo, "merge", path.join(dir(), "x"), "--dir", dir(), "--branch", "b").json.reason, "run not pinned");
  assert.equal(m2.json.tips.length, 2);

  // task --base: passes on a branch built from the base, fails on one that does not contain it.
  const good = path.join(run, "good");
  git(repo, "worktree", "add", "-q", "-b", "pi/good", good, p1.json.base_ref);
  commit(good, "g.txt", "g\n");
  const ok = gateIn(good, "task", report("done"), "--check", "true", "--base", base, "--run", run, "--id", "good");
  assert.equal(ok.json.ok, true, ok.json.reason);
  assert.equal(ok.json.base, base);
  assert.equal(ok.json.commits, 1);
  const late = path.join(run, "late");
  git(repo, "worktree", "add", "-q", "-b", "pi/late", late, "main");
  commit(late, "l.txt", "l\n");
  const other = git(good, "rev-parse", "HEAD");
  const bad = gateIn(late, "task", report("done"), "--check", "true", "--base", other, "--run", run, "--id", "late");
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.reason, `branch does not start from the run's base ${other}`);

  // The ledger gains the task and review worktrees.
  const review = path.join(run, "review", "good-1");
  git(repo, "worktree", "add", "-q", "-b", "pi/review", review, "pi/good");
  const v = gateIn(review, "verdict", report("Does what was asked: yes\nSound: yes\n"), "--run", run, "--id", "good");
  assert.equal(v.json.verdict, "clean");
  assert.equal(v.json.branch, "pi/review");
  assert.equal(v.json.worktree, fs.realpathSync(review));
  assert.equal(gate("verdict", report("Does what was asked: yes\nSound: yes\n")).json.branch, undefined);
  const made = readRun(run).made.map((m) => `${m.kind}:${m.id}:${m.branch}`);
  assert.deepEqual(made, ["deps:t3:pi/deps", "task:good:pi/good", "task:late:pi/late", "review:good:pi/review"]);

  // A session's own linked worktree is never recorded, so abandon cannot remove it.
  const session = path.join(dir(), "session");
  git(repo, "worktree", "add", "-q", "-b", "session", session, "main");
  fs.writeFileSync(path.join(session, "precious.txt"), "keep\n");
  const fromSession = gateIn(session, "verdict", report("Does what was asked: yes\nSound: yes\n"), "--run", run, "--id", "s");
  assert.equal(fromSession.json.verdict, "clean");
  assert.ok(!readRun(run).made.some((m) => m.branch === "session"));

  // A file the reviewer leaves untracked is not the implementer's dirt, but the same file there is.
  fs.writeFileSync(path.join(review, "notes.txt"), "scratch\n");
  const unaffected = gateIn(good, "task", report("done"), "--check", "true", "--base", base);
  assert.equal(unaffected.json.clean, true);
  assert.equal(unaffected.json.ok, true);
  fs.rmSync(path.join(review, "notes.txt"));
  fs.writeFileSync(path.join(good, "notes.txt"), "scratch\n");
  const dirty = gateIn(good, "task", report("done"), "--check", "true", "--base", base);
  assert.equal(dirty.json.clean, false);
  assert.equal(dirty.json.ok, false);
  fs.rmSync(path.join(good, "notes.txt"));

  // A review worktree under the runner's own worktree root is recorded when the gate is told the root,
  // and reported as unrecorded when it is not.
  const root = dir();
  const rooted = path.join(root, "repo", "r-review-1");
  const strayed = path.join(root, "repo", "r-review-2");
  git(repo, "worktree", "add", "-q", "-b", "recipe/r-review-1", rooted, "pi/good");
  git(repo, "worktree", "add", "-q", "-b", "recipe/r-review-2", strayed, "pi/good");
  const verdictIn = (cwd, extra) => {
    const r = spawnSync(process.execPath, [script, "verdict", report("Does what was asked: yes\nSound: yes\n"), "--run", run, "--id", "good"], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    return JSON.parse(r.stdout);
  };
  const unknown = verdictIn(strayed, {});
  assert.equal(unknown.recorded, false);
  assert.ok(!readRun(run).made.some((m) => m.branch === "recipe/r-review-2"));
  const known = verdictIn(rooted, { RECIPE_WORKTREE_ROOT: root });
  assert.equal(known.recorded, true);
  assert.ok(readRun(run).made.some((m) => m.kind === "review" && m.branch === "recipe/r-review-1"));
  assert.equal(verdictIn(review, {}).recorded, true);

  // integrate --tidy clears recorded review and deps worktrees and the base ref, keeping the integration branch.
  const integration = path.join(run, "integration");
  git(repo, "worktree", "add", "-q", "-b", "implement/x", integration, p1.json.base_ref);
  git(integration, "merge", "-q", "--no-edit", "pi/good");
  fs.writeFileSync(path.join(run, "pr.md"), "Title\n");
  fs.writeFileSync(path.join(run, "heavy.md"), "none\n");
  const tidy = gateIn(repo, "integrate", run, "--tasks", "good:pi/good", "--branch", "implement/x", "--tidy", "yes");
  assert.equal(tidy.json.ok, true, tidy.json.reasons.join("; "));
  assert.deepEqual(tidy.json.tidy_problems, []);
  assert.deepEqual(tidy.json.left_over, []);
  assert.ok(!fs.existsSync(review) && !fs.existsSync(deps) && !fs.existsSync(rooted));
  assert.ok(fs.existsSync(strayed), "an unrecorded worktree is not the ledger's to remove");
  const left = git(repo, "branch", "--format=%(refname:short)").split("\n");
  assert.ok(left.includes("implement/x"));
  assert.ok(!left.includes("pi/review") && !left.includes("pi/deps") && !left.includes("recipe/r-review-1"));
  assert.ok(left.includes("pi/late"), "set-aside task branches stay");
  assert.ok(fs.existsSync(late));
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", p1.json.base_ref], { cwd: repo }).status, 1);

  // abandon removes what was recorded, except kept branches.
  const gone = gateIn(repo, "abandon", run, "--keep", "pi/late");
  assert.equal(gone.json.ok, true);
  assert.deepEqual(gone.json.kept, ["pi/late"]);
  assert.ok(!fs.existsSync(good) && fs.existsSync(late) === false);
  assert.ok(!git(repo, "branch", "--format=%(refname:short)").split("\n").includes("pi/good"));
  assert.ok(git(repo, "branch", "--format=%(refname:short)").split("\n").includes("pi/late"));
  assert.ok(fs.existsSync(path.join(session, "precious.txt")));
  assert.ok(git(repo, "branch", "--format=%(refname:short)").split("\n").includes("session"));
}

// resume: last state of each task from the ledger, branches and review files.
{
  const env = { ...process.env, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repo = dir();
  git(repo, "init", "-q", "-b", "main");
  const commit = (file) => {
    fs.writeFileSync(path.join(repo, file), file);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", file);
    return git(repo, "rev-parse", "HEAD");
  };
  const base = commit("base.txt");
  git(repo, "branch", "pi/a");
  git(repo, "checkout", "-q", "-b", "pi/b");
  const bTip = commit("b.txt");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "--no-edit", "pi/b");
  git(repo, "branch", "integ");
  git(repo, "checkout", "-q", "-b", "pi/c", base);
  const cTip = commit("c.txt");
  git(repo, "checkout", "-q", "main");

  const run = dir();
  const none = gate("resume", run, "--repo", repo);
  assert.equal(none.json.ok, false);
  assert.deepEqual(none.json.tasks, {});

  const made = [
    { kind: "task", id: "a", branch: "pi/a", worktree: "/x/a" },
    { kind: "task", id: "b-1", branch: "pi/b", worktree: "/x/b" },
    { kind: "task", id: "c", branch: "pi/c", worktree: "/x/c" },
    { kind: "task", id: "gone", branch: "pi/gone", worktree: "/x/g" },
    { kind: "task", id: "d.1", branch: "pi/d", worktree: "/x/d" },
    { kind: "task", id: "dx1", branch: "pi/dx", worktree: "/x/dx" },
    { kind: "review", id: "r", branch: "pi/rev", worktree: "/x/r" },
  ];
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ repo, base, base_ref: "refs/x", made, merges: {} }));
  const ok = "Does what was asked: yes\nSound: yes\n";
  const bad = "Does what was asked: partly\nSound: yes\n";
  fs.writeFileSync(path.join(run, "review-b-1-1.md"), bad);
  fs.writeFileSync(path.join(run, "review-b-1-2.md"), bad);
  fs.writeFileSync(path.join(run, "review-b-1-10.md"), ok);
  fs.writeFileSync(path.join(run, "review-c-1.md"), ok);
  fs.writeFileSync(path.join(run, "review-c-2.md"), bad);
  fs.writeFileSync(path.join(run, "review-dx1-4.md"), bad);
  fs.writeFileSync(path.join(run, "review-d.1-1.md"), ok);
  fs.writeFileSync(path.join(run, "tidied.json"), JSON.stringify({ "pi/d": bTip }));

  const r = gate("resume", run, "--repo", repo, "--branch", "integ").json;
  assert.equal(r.ok, true);
  assert.equal(r.base, base);
  assert.deepEqual(Object.keys(r.tasks).sort(), ["a", "b-1", "c", "d.1", "dx1", "gone"]);
  assert.deepEqual(r.tasks.a, { branch: "pi/a", head: base, review: null, reviews: 0, review_file: null, merged: true });
  assert.deepEqual(r.tasks["b-1"], { branch: "pi/b", head: bTip, review: "clean", reviews: 10, review_file: path.join(run, "review-b-1-10.md"), merged: true });
  assert.deepEqual(r.tasks.c, { branch: "pi/c", head: cTip, review: "needs-work", reviews: 2, review_file: path.join(run, "review-c-2.md"), merged: false });
  assert.deepEqual(r.tasks.gone, { branch: "pi/gone", head: null, review: null, reviews: 0, review_file: null, merged: false });
  assert.deepEqual(r.tasks["d.1"], { branch: "pi/d", head: null, review: "clean", reviews: 1, review_file: path.join(run, "review-d.1-1.md"), merged: true });
  assert.equal(r.tasks.dx1.reviews, 4);
  const hand = "handoff: half done\n" + ok;
  fs.writeFileSync(path.join(run, "review-h-1.md"), hand);
  fs.writeFileSync(path.join(run, "review-h-1.merged.md"), bad);
  fs.writeFileSync(path.join(run, "review-o-1.md"), hand);
  fs.writeFileSync(path.join(run, "review-o-2.md"), hand);
  fs.writeFileSync(path.join(run, "review-o-0.md"), bad);
  fs.writeFileSync(path.join(run, "review-q-3.md"), hand);
  const withHand = JSON.parse(fs.readFileSync(path.join(run, "run.json"), "utf8"));
  withHand.made.push({ kind: "task", id: "h", branch: "pi/a", worktree: "/x/h" }, { kind: "task", id: "o", branch: "pi/a", worktree: "/x/o" }, { kind: "task", id: "q", branch: "pi/a", worktree: "/x/q" });
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify(withHand));
  const h = gate("resume", run, "--repo", repo, "--branch", "integ").json.tasks;
  assert.equal(h.h.review, "needs-work");
  assert.equal(h.h.review_file, path.join(run, "review-h-1.merged.md"));
  assert.equal(h.o.review, "needs-work");
  assert.equal(h.o.reviews, 2);
  assert.equal(h.q.review, null);
  assert.equal(h.q.reviews, 3);
  assert.equal(h.q.review_file, null);
  assert.equal(gate("resume", run, "--repo", repo).json.tasks["b-1"].merged, false);
  assert.equal(gate("resume", run, "--repo", repo, "--branch", "nope").json.tasks.a.merged, false);
}


// repro, hypotheses, task --verify/--in with signatures, diagnosis next/research.
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
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "init");
  const run = dir();
  const worktree = (branch, where = path.join(dir(), "wt")) => {
    git(source, "worktree", "add", "-q", "-b", branch, where, "main");
    return where;
  };
  const commit = (wt, file, text) => {
    fs.writeFileSync(path.join(wt, file), text);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", file);
  };
  const report = (text) => write("report.md", text);

  // repro: exit status against the expectation, the log, and the usage errors.
  const r1 = gateIn(source, "repro", run, "--command", "echo out; echo err >&2; exit 3");
  assert.equal(r1.status, 0);
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.reason, "");
  assert.equal(r1.json.exit, 3);
  assert.equal(r1.json.timed_out, false);
  assert.equal(r1.json.expect, "fail");
  assert.equal(r1.json.log, path.join(run, "repro.log"));
  assert.equal(fs.readFileSync(r1.json.log, "utf8"), "out\nerr\n");
  assert.match(r1.json.tail, /out\nerr/);
  const r2 = gateIn(source, "repro", run, "--command", "true");
  assert.equal(r2.json.ok, false);
  assert.equal(r2.json.reason, "the command passed (exit 0) but was expected to fail");
  const r3 = gateIn(source, "repro", run, "--command", "true", "--expect", "pass");
  assert.equal(r3.json.ok, true);
  const r4 = gateIn(source, "repro", run, "--command", "exit 5", "--expect", "pass", "--id", "again");
  assert.equal(r4.json.ok, false);
  assert.equal(r4.json.reason, "the command failed (exit 5) but was expected to pass");
  assert.ok(fs.existsSync(path.join(run, "again.log")));
  assert.equal(gateIn(source, "repro", run).status, 2);
  assert.equal(gateIn(source, "repro", run, "--command", "true", "--expect", "maybe").status, 2);
  assert.equal(gateIn(source, "repro", path.join(dir(), "new", "dir"), "--command", "true").json.ok, false);

  // repro: output beyond the capture limit is not a reproduction.
  const flood = gateIn(source, "repro", run, "--command", "head -c 300000000 /dev/zero | tr '\\0' x");
  assert.equal(flood.json.ok, false);
  assert.match(flood.json.reason, /more output than can be captured/);

  // repro: a linked worktree under the run directory is recorded as kind repro; --in redirects.
  const inRun = path.join(run, "wt-repro");
  git(source, "worktree", "add", "-q", "-b", "pi/repro", inRun, "main");
  const rec = gateIn(inRun, "repro", run, "--command", "exit 1", "--id", "reproduce");
  assert.equal(rec.json.branch, "pi/repro");
  assert.equal(rec.json.head, git(inRun, "rev-parse", "HEAD"));
  const ledger = JSON.parse(fs.readFileSync(path.join(run, "run.json"), "utf8"));
  assert.deepEqual(ledger.made.map((m) => `${m.kind}:${m.id}:${m.branch}`), ["repro:reproduce:pi/repro"]);
  const hypo = write("hh.md", "## 1. a\nCheck first: x\n## 2. b\nCheck first: y\n");
  const hypoWt = path.join(run, "wt-hypo");
  git(source, "worktree", "add", "-q", "-b", "pi/hypo", hypoWt, "main");
  const hr = gateIn(hypoWt, "hypotheses", hypo, "--run", run, "--id", "hypothesize");
  assert.equal(hr.json.branch, "pi/hypo");
  assert.equal(hr.json.ok, true);
  const ledger2 = JSON.parse(fs.readFileSync(path.join(run, "run.json"), "utf8"));
  assert.ok(ledger2.made.some((m) => m.kind === "hypothesize" && m.id === "hypothesize" && m.branch === "pi/hypo"));
  const redirected = gateIn(source, "repro", run, "--command", "pwd; exit 1", "--in", inRun);
  assert.equal(redirected.json.tail.trim(), fs.realpathSync(inRun));
  assert.equal(redirected.json.branch, "pi/repro");

  // signature: stable across worktrees, hashes, temp names and long digit runs; moved by small counts.
  const sigOf = (cmd) => gateIn(source, "repro", run, "--command", cmd).json.signature;
  const noisy = (n) => `echo "failed in $PWD at 12345${n} commit deadbeef0${n}1 /tmp/x${n}/y"; exit 1`;
  assert.equal(sigOf(noisy(1)), sigOf(noisy(2)));
  assert.notEqual(sigOf("echo expected 3, got 4; exit 1"), sigOf("echo expected 3, got 5; exit 1"));
  assert.equal(sigOf("echo 'duration_ms 45.7'; echo 'ok in 3 ms'; exit 1"), sigOf("echo 'duration_ms 44.8'; echo 'ok in 9 ms'; exit 1"));
  assert.equal(sigOf("echo 'took 0.01s'; exit 1"), sigOf("echo 'took 0.03s'; exit 1"));
  assert.equal(sigOf("echo 'ran 12 duration'; exit 1"), sigOf("echo 'ran 98 duration'; exit 1"));
  assert.notEqual(sigOf("echo a; echo b; exit 1"), sigOf("echo a; echo c; exit 1"));
  assert.notEqual(sigOf("echo same; exit 1"), sigOf("echo same >&2; exit 1"));
  assert.equal(sigOf("echo $((1+1)); exit 1"), sigOf("echo 2; exit 1"));

  // The same command gives the same signature from repro and task in different worktrees.
  const wtA = worktree("pi/sa");
  const wtB = worktree("pi/sb");
  commit(wtB, "b.txt", "b\n");
  const cmd = 'echo "no good in $PWD, got 4"; echo "trace 987654 at /var/tmp/q1" >&2; exit 1';
  const fromRepro = gateIn(wtA, "repro", run, "--command", cmd).json.signature;
  const fromTask = gateIn(wtB, "task", report("done"), "--repo", source, "--check", cmd).json;
  assert.equal(fromTask.ok, false);
  assert.equal(fromTask.check.signature, fromRepro);
  assert.equal(fromTask.signature, fromRepro);

  // task --verify: a failing verify decides the reason and the signature; the check does not run.
  const bad = gateIn(wtB, "task", report("done"), "--repo", source, "--verify", "echo nope; exit 4", "--check", "touch ran.txt");
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.reason, /^verify failed \(exit 4\): nope/);
  assert.equal(bad.json.verify.exit, 4);
  assert.equal(bad.json.check.exit, null);
  assert.equal(bad.json.check.signature, null);
  assert.ok(bad.json.signature);
  assert.equal(bad.json.signature, bad.json.verify.signature);
  assert.equal(fs.existsSync(path.join(wtB, "ran.txt")), false);

  // --verify alone works; ok has no signature; without --check the check slot stays empty.
  const only = gateIn(wtB, "task", report("done"), "--repo", source, "--verify", "true");
  assert.equal(only.json.ok, true, only.json.reason);
  assert.equal(only.json.signature, null);
  assert.deepEqual(only.json.check, { command: null, exit: null, tail: "", signature: null });
  assert.equal(only.json.verify.exit, 0);
  const plain = gateIn(wtB, "task", report("done"), "--repo", source, "--check", "true");
  assert.equal(plain.json.verify, null);
  assert.equal(gateIn(wtB, "task", report("done"), "--repo", source).status, 2);

  // A passing verify then a failing check: the check signature is used.
  const checkFails = gateIn(wtB, "task", report("done"), "--repo", source, "--verify", "true", "--check", "echo late; exit 2");
  assert.match(checkFails.json.reason, /^check failed \(exit 2\): late/);
  assert.equal(checkFails.json.signature, checkFails.json.check.signature);

  // --in checks a worktree other than the working directory.
  const elsewhere = gateIn(source, "task", report("done"), "--repo", source, "--in", wtB, "--check", "pwd");
  assert.equal(elsewhere.json.ok, true, elsewhere.json.reason);
  assert.equal(elsewhere.json.branch, "pi/sb");
  assert.equal(fs.realpathSync(elsewhere.json.worktree), fs.realpathSync(wtB));
  assert.equal(fs.realpathSync(elsewhere.json.check.tail.trim()), fs.realpathSync(wtB));

  // A failure with no command takes its signature from the reason, the same each time.
  const wtC = worktree("pi/sc");
  const none1 = gateIn(wtC, "task", report("done"), "--repo", source, "--check", "true");
  const none2 = gateIn(wtC, "task", report("done"), "--repo", source, "--check", "true");
  assert.equal(none1.json.reason, "no commits on the branch");
  assert.ok(none1.json.signature);
  assert.equal(none1.json.signature, none2.json.signature);
  const blocked = gateIn(wtC, "task", report("blocked: x"), "--repo", source, "--check", "true");
  assert.notEqual(blocked.json.signature, none1.json.signature);
}

// hypotheses: ranked by number, each needing a claim and a Check first line.
{
  const two = write(
    "h.md",
    [
      "# Hypotheses",
      "## 2. The cache is stale",
      "Why: it was written before the fix.",
      "**Check first:** clear the cache and rerun",
      "",
      "## 1. The parser drops the last line",
      "- Check first: feed it a file with no trailing newline",
      "",
      "## 1. A repeated rank is dropped",
      "Check first: nothing",
    ].join("\n"),
  );
  const r = gate("hypotheses", two);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.problem, null);
  assert.deepEqual(r.json.hypotheses, [
    { rank: 1, claim: "The parser drops the last line", check: "feed it a file with no trailing newline" },
    { rank: 2, claim: "The cache is stale", check: "clear the cache and rerun" },
  ]);
  const one = gate("hypotheses", write("h.md", "## 1. Only one\nCheck first: look\n")).json;
  assert.equal(one.ok, false);
  assert.equal(one.problem, "fewer than two hypotheses with a Check first line");
  const noCheck = gate("hypotheses", write("h.md", "## 1. First\nCheck first: look\n## 2. Second\nno check here\n")).json;
  assert.equal(noCheck.ok, false);
  assert.equal(noCheck.hypotheses.length, 1);
  assert.equal(gate("hypotheses", path.join(tmp, "absent.md")).json.problem, "file missing");
  const raw = gate(
    "hypotheses",
    write("h.md", "## 1. `cache_dir` is read before init_cache() runs\n**Check first:** `grep -n cache_dir src/app.js` shows __x__\n## 2. The lock in **lock_file.js** stays\nCheck first: run `ls_all`\n"),
  ).json;
  assert.deepEqual(raw.hypotheses, [
    { rank: 1, claim: "`cache_dir` is read before init_cache() runs", check: "`grep -n cache_dir src/app.js` shows __x__" },
    { rank: 2, claim: "The lock in **lock_file.js** stays", check: "run `ls_all`" },
  ]);
}

// diagnosis: next and research.
{
  const diag = (text, ...rest) => gate("diagnosis", write("diag.md", text), ...rest).json;
  const next = diag("action: next\nreason: this idea is spent\n");
  assert.equal(next.ok, true);
  assert.equal(next.action, "next");
  assert.equal(next.question, "");
  const research = diag("action: research\nreason: need the flag semantics\n## Brief\n- What does the --frozen flag do in tool X?\nMore detail.\n");
  assert.equal(research.ok, true);
  assert.equal(research.action, "research");
  assert.equal(research.question, "What does the --frozen flag do in tool X?");
  assert.equal(diag("action: research\nreason: r\n## Brief\n> " + "q".repeat(400) + "\n").question.length, 300);
  const noQuestion = diag("action: research\nreason: r\n## Brief\n\n");
  assert.equal(noQuestion.ok, false);
  assert.equal(noQuestion.problem, "action research needs a question as the first line of ## Brief");
  assert.equal(diag("action: research\nreason: r\n").ok, false);
  assert.equal(diag("action: research\nreason: r\n## Brief\nWhy?\n", "--allow", "fix,decide").ok, false);
  assert.equal(diag("action: fix\nreason: r\n## Brief\nWhy?\n", "--allow", "fix,decide").question, "");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-gate: all assertions passed");
