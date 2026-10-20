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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("recipe-gate: all assertions passed");
