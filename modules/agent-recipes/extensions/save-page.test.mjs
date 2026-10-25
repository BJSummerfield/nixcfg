/**
 * Behaviour tests for save_page. Run by `nix flake check`.
 *
 * The network is replaced by an injected fetch returning fixtures; pi's own
 * tool registration is a stub that records the tool definition.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import savePageExtension, { htmlToMarkdown, outlineOf, savePage } from "./save-page.js";

const FIXTURE = `<!doctype html>
<html><head><title>Ignored title</title><style>body { color: red }</style>
<script>var tracking = "SCRIPT-TEXT";</script></head>
<body>
<nav><a href="/home">NAV-LINK</a></nav>
<main>
<h1>Widget guide</h1>
<p>A <strong>widget</strong> is a <em>small</em> thing &amp; useful. See the
   <a href="/docs/api?x=1">API docs</a> or <a href="https://example.org/ext">the site</a>.</p>
<h2>Install</h2>
<ul><li>Run <code>npm i widget</code></li><li>Import it</li></ul>
<pre><code class="language-js">const w = new Widget();
if (w.size &lt; 3) { w.grow(); }
</code></pre>
<h2>Options</h2>
<table><tr><th>name</th><th>default</th></tr><tr><td>size</td><td>3</td></tr></table>
<p>Caf&eacute; &#169; &#x41;</p>
</main>
<footer>FOOTER-TEXT</footer>
</body></html>`;

// The converter keeps structure and drops page furniture.
{
  const md = htmlToMarkdown(FIXTURE, "https://example.com/guide/");
  assert.match(md, /^# Widget guide$/m);
  assert.match(md, /^## Install$/m);
  assert.match(md, /^## Options$/m);
  assert.match(md, /\*\*widget\*\*/);
  assert.match(md, /\*small\*/);
  assert.match(md, /useful\./);
  assert.match(md, /& useful/);
  assert.match(md, /\[API docs\]\(https:\/\/example\.com\/docs\/api\?x=1\)/);
  assert.match(md, /\[the site\]\(https:\/\/example\.org\/ext\)/);
  assert.match(md, /^- Run `npm i widget`$/m);
  assert.match(md, /^- Import it$/m);
  assert.match(md, /```js\nconst w = new Widget\(\);\nif \(w\.size < 3\) \{ w\.grow\(\); \}\n```/);
  assert.match(md, /size \| 3 \|/);
  assert.match(md, /Café © A/);
  for (const gone of ["SCRIPT-TEXT", "NAV-LINK", "FOOTER-TEXT", "Ignored title", "color: red"]) {
    assert.ok(!md.includes(gone), `${gone} must be stripped`);
  }
  assert.ok(!/\n{3,}/.test(md));
  assert.ok(md.endsWith("\n"));
}

// A page without main or body is converted whole; empty input stays empty.
{
  assert.equal(htmlToMarkdown("<p>Just text</p>"), "Just text\n");
  assert.equal(htmlToMarkdown("<script>x()</script>"), "");
}

// The outline carries 1-based line numbers into the saved file and skips
// headings inside code fences.
{
  const md = "# A\n\ntext\n\n```\n# not a heading\n```\n\n## B\n";
  assert.deepEqual(outlineOf(md), [
    { line: 1, level: 1, text: "A" },
    { line: 9, level: 2, text: "B" },
  ]);
  const converted = htmlToMarkdown(FIXTURE, "https://example.com/");
  const lines = converted.split("\n");
  for (const h of outlineOf(converted)) assert.equal(lines[h.line - 1], `${"#".repeat(h.level)} ${h.text}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "save-page-"));

const reply = (body, { status = 200, type = "text/html; charset=utf-8", url = "https://example.com/guide/" } = {}) => {
  const headers = new Map([["content-type", type]]);
  return {
    ok: status < 400,
    status,
    url,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  };
};

// The handler writes the file and returns path, bytes and outline, never the text.
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return reply(FIXTURE);
  };
  const target = path.join(dir, "nested", "page.md");
  const result = await savePage({ url: "https://example.com/guide/", path: target }, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(result.path, target);
  const written = fs.readFileSync(target, "utf8");
  assert.equal(result.bytes, Buffer.byteLength(written));
  assert.deepEqual(
    result.outline.map((h) => h.text),
    ["Widget guide", "Install", "Options"],
  );
  assert.ok(!JSON.stringify(result).includes("useful"));
  assert.match(written, /\[API docs\]\(https:\/\/example\.com\/docs\/api\?x=1\)/);
}

// Text, markdown and JSON are written as they came.
{
  const raw = '{"a": 1}\n';
  const target = path.join(dir, "data.json");
  const result = await savePage(
    { url: "https://example.com/data.json", path: target },
    { fetchImpl: async () => reply(raw, { type: "application/json" }) },
  );
  assert.equal(fs.readFileSync(target, "utf8"), raw);
  assert.equal(result.bytes, Buffer.byteLength(raw));
  assert.deepEqual(result.outline, []);

  const md = "# Notes\n\nbody\n";
  const mdTarget = path.join(dir, "notes.md");
  const mdResult = await savePage(
    { url: "https://example.com/notes.md", path: mdTarget },
    { fetchImpl: async () => reply(md, { type: "text/markdown" }) },
  );
  assert.equal(fs.readFileSync(mdTarget, "utf8"), md);
  assert.deepEqual(mdResult.outline, [{ line: 1, level: 1, text: "Notes" }]);
}

// What it cannot handle is an error that names fetch_content, and nothing is
// fetched or written for URLs refused up front.
{
  const never = async () => {
    throw new Error("fetch must not run");
  };
  for (const url of [
    "https://github.com/owner/repo/blob/main/README.md",
    "https://www.youtube.com/watch?v=abc",
    "https://example.com/paper.pdf",
  ]) {
    const target = path.join(dir, "refused.md");
    await assert.rejects(savePage({ url, path: target }, { fetchImpl: never }), /fetch_content/);
    assert.ok(!fs.existsSync(target));
  }
  await assert.rejects(
    savePage(
      { url: "https://example.com/download", path: path.join(dir, "late.md") },
      { fetchImpl: async () => reply("%PDF", { type: "application/pdf" }) },
    ),
    /PDF; use fetch_content/,
  );
  await assert.rejects(
    savePage({ url: "ftp://example.com/x", path: path.join(dir, "x.md") }, { fetchImpl: never }),
    /only http and https/,
  );
  await assert.rejects(
    savePage({ url: "https://example.com/gone", path: path.join(dir, "gone.md") }, { fetchImpl: async () => reply("", { status: 404 }) }),
    /HTTP 404/,
  );
  await assert.rejects(
    savePage(
      { url: "https://example.com/down", path: path.join(dir, "down.md") },
      { fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")) },
    ),
    /fetch failed: ECONNREFUSED/,
  );
}

// Registration: one tool named save_page whose execute returns text content
// holding only the JSON summary.
{
  const tools = [];
  savePageExtension(
    { registerTool: (tool) => tools.push(tool) },
    { fetchImpl: async () => reply(FIXTURE) },
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "save_page");
  assert.deepEqual(tools[0].parameters.required, ["url", "path"]);
  const target = path.join(dir, "via-tool.md");
  const out = await tools[0].execute("call-1", { url: "https://example.com/guide/", path: target }, undefined, undefined, {});
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, "text");
  const parsed = JSON.parse(out.content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["bytes", "outline", "path"]);
  assert.equal(parsed.path, target);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("save-page: ok");
