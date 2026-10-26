/**
 * Located-quote checks of recipe-gate: the quotes subcommand and the quote
 * check inside verdict and gaps. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./recipe-gate.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-gate-quotes-"));
let counter = 0;

const dir = () => {
  const d = path.join(tmp, `d${counter++}`);
  fs.mkdirSync(d);
  return d;
};
const write = (name, text, where = dir()) => {
  const f = path.join(where, name);
  fs.writeFileSync(f, text);
  return f;
};
const gate = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: opts.cwd });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
};

const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
const sourceLines = [...filler(29, "pad"), "alpha  beta", "gamma delta", ...filler(30, "tail")];
const repo = dir();
write("src.txt", sourceLines.join("\n") + "\n", repo);
const abs = path.join(repo, "src.txt");

const notes = (...blocks) => blocks.map((b) => b.map((l) => `> ${l}`).join("\n")).join("\n\n") + "\n";

// quotes: found cases
{
  const f = write("n.md", notes(["src.txt:30-31", "alpha beta", "gamma delta"]));
  const r = gate(["quotes", f, "--repo", repo]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: true, quotes: 1, missing: [] });

  const a = write("a.md", notes([`${abs}:30`, "alpha beta"]));
  assert.deepEqual(gate(["quotes", a]).json, { ok: true, quotes: 1, missing: [] });

  const b = write("b.md", notes(["`src.txt:30-31`", "```", "alpha beta", "```"]));
  assert.deepEqual(gate(["quotes", b, "--repo", repo]).json, { ok: true, quotes: 1, missing: [] });

  // line 30 is within 10 lines of a citation at 40 and not of one at 41
  const near = write("near.md", notes(["src.txt:40", "alpha beta"]));
  assert.equal(gate(["quotes", near, "--repo", repo]).json.ok, true);
  const far = write("far.md", notes(["src.txt:42", "alpha beta"]));
  const miss = gate(["quotes", far, "--repo", repo]).json;
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missing, [{ location: "src.txt:42", quote: "alpha beta" }]);
  assert.equal(miss.reason, "quote not found in its file: src.txt:42");
}

// quotes: missing cases
{
  const t = write("t.md", notes(["src.txt:30", "not in the file"]));
  const r = gate(["quotes", t, "--repo", repo]).json;
  assert.equal(r.ok, false);
  assert.equal(r.quotes, 1);
  assert.deepEqual(r.missing, [{ location: "src.txt:30", quote: "not in the file" }]);

  const g = write("g.md", notes(["gone.txt:1", "alpha beta"], ["src.txt:30", "absent"]));
  const m = gate(["quotes", g, "--repo", repo]).json;
  assert.equal(m.reason, "quote not found in its file: gone.txt:1, src.txt:30");
}

// quotes: what is not a located quote, and file-level answers
{
  const u = write("u.md", notes(["just some words"], ["src.txt:30"]));
  assert.deepEqual(gate(["quotes", u, "--repo", repo]).json, { ok: true, quotes: 0, missing: [] });
  assert.deepEqual(gate(["quotes", write("e.md", "no quotes here\n")]).json, { ok: true, quotes: 0, missing: [] });
  const none = gate(["quotes", path.join(tmp, "nope.md")]);
  assert.equal(none.status, 0);
  assert.equal(none.json.ok, false);
  assert.equal(none.json.reason, "file missing");
  assert.equal(gate(["quotes"]).status, 2);
}

const review = (quoteBlocks) =>
  `# Review\n\nDoes what was asked: yes\nSound: yes\n\n## Open gaps\n\n- one | a question\n\n${quoteBlocks}`;

// verdict and gaps
{
  const okQuotes = write("r1.md", review(notes(["src.txt:30", "alpha beta"])));
  const plain = write("r2.md", review(""));
  const expected = { asked: "yes", sound: "yes", clean: true, verdict: "clean" };
  assert.deepEqual(gate(["verdict", okQuotes, "--repo", repo]).json, expected);
  assert.deepEqual(gate(["verdict", plain]).json, expected);

  const bad = write("r3.md", review(notes(["src.txt:30", "invented text"])));
  const v = gate(["verdict", bad, "--repo", repo]).json;
  assert.equal(v.verdict, "invalid");
  assert.equal(v.clean, false);
  assert.equal(v.asked, "yes");
  assert.equal(v.sound, "yes");
  assert.equal(v.reason, "quote not found in its file: src.txt:30");
  assert.deepEqual(v.missing, [{ location: "src.txt:30", quote: "invented text" }]);

  // without --repo the working directory is the repo
  assert.deepEqual(gate(["verdict", okQuotes], { cwd: repo }).json, expected);
  assert.equal(gate(["verdict", okQuotes], { cwd: tmp }).json.verdict, "invalid");

  const g = gate(["gaps", bad, "--repo", repo]).json;
  assert.equal(g.ok, false);
  assert.equal(g.verdict, "invalid");
  const good = gate(["gaps", okQuotes, "--repo", repo]).json;
  assert.equal(good.ok, true);
  assert.equal(good.verdict, "clean");
}

fs.rmSync(tmp, { recursive: true, force: true });
