// Checks between the steps of the research recipe. Each subcommand reads
// files, prints one JSON object on stdout and exits 0 on a decision; only
// usage errors (2) and unreadable input where a decision is impossible (1)
// exit nonzero.
//
//   urls <file>                    source list -> {ok, urls:[{url, angle, why, kind}]}
//   paths <file>                   locator list -> {ok, paths:[{path, range, kind, why}]}
//   extract <file> [--cap BYTES] [--repo DIR]
//                                  {ok, bytes, quotes, over_cap}; cap defaults to 24 KB.
//                                  An extract with a `File: <path>` header line
//                                  (and optional `Range: <start>-<end>`; a
//                                  trailing `(lines a-b, c-d)` on the File line
//                                  stands in when there is no Range line) comes
//                                  from a repository file: every quote must
//                                  appear, whitespace-normalized, in that file
//                                  (within RANGE_MARGIN_LINES of those lines
//                                  when a range is given), the
//                                  path is relative to --repo (default: the
//                                  working directory), and the output gains
//                                  file and missing:[quote]; ok also needs
//                                  missing to be empty
//   quotes <file> [--repo DIR]     {ok, quotes, missing:[{location, quote}]}; every
//                                  located quote must appear in its cited file;
//                                  the output adds reason when not ok
//   size <dir> [--window N]       {bytes, est_tokens, split}; N defaults to 221184
//   verdict <review.md> [--repo DIR] [--run DIR --id ID]
//                                  {asked, sound, clean, verdict}; a located quote
//                                  not found in its file makes the verdict
//                                  invalid and adds reason and missing; read from the
//                                  first verdict line and the few lines after
//                                  it, up to the next heading. With --run the
//                                  working directory's linked worktree is
//                                  recorded in <DIR>/run.json as kind review
//                                  and the output gains branch and worktree
//   angles <file>                  angle list -> {ok, angles:[{id, question}]}
//   gaps <review.md> [--repo DIR]  {ok, angles:[{id, question}], asked, sound, clean, verdict}
//   diagnosis <file> [--allow a,b] [--verdict yes]
//                                  {ok, action, reason, verdict, owns:[], brief, question, problem}
//   plan <dir> [--sizing FILE] [--repo DIR] [--limit N]
//                                  plan directory -> {ok, sizing:{base, k_read,
//                                  growth_p90}, tasks:[{id, owns, reads, check,
//                                  depends, research, bytes, est}], oversize:[id],
//                                  overlaps:[[a, b, file]], missing:[text],
//                                  cycles:[[id, ...]]}
//   task <report> [--check CMD] [--verify CMD] [--in DIR] [--owns a,b] [--repo DIR]
//                 [--base SHA] [--run DIR --id ID]
//                                  run in a task worktree -> {ok, reason, report:{status,
//                                  why}, branch, worktree, head, base, clean, commits,
//                                  identity:{expected, mismatched, unreadable}, files, outside,
//                                  check:{command, exit, tail, signature},
//                                  verify:{command, exit, tail, signature} | null, signature}
//   repro <dir> --command CMD [--expect fail|pass] [--id ID] [--in DIR]
//                                  run a command and judge its exit status ->
//                                  {ok, reason, command, expect, exit, timed_out, tail,
//                                  signature, log, branch, worktree, head}
//   hypotheses <file> [--run DIR --id ID]  ranked hypotheses -> {ok, hypotheses:[{rank, claim,
//                                  check}], problem}
//   pin <dir> --repo DIR           fix the run's base commit and ref in <dir>/run.json ->
//                                  {ok, reason, repo, base, base_ref, reused}
//   merge <worktree> --dir DIR --branch NAME [--tips id:branch,...] [--onto REF] [--refresh yes]
//                    [--check CMD] [--kind K] [--id ID]
//                                  merge the tips into the worktree, creating it from
//                                  --onto (default the run's base ref) when absent ->
//                                  {ok, reason, branch, head, tips, merged, conflict,
//                                  resolved, check}
//   abandon <dir> [--keep a,b]     remove every worktree, branch and the base ref the
//                                  run recorded, except the kept branches ->
//                                  {ok, removed, kept, problems}
//   integrate <dir> --tasks id:branch,... [--branch NAME] [--tidy yes]
//                                  integration worktree at <dir>/integration ->
//                                  {ok, reasons, branch, head, merged:[id], unmerged:[id],
//                                  clean, heavy_check, pr_text[, tidied:[id], tidy_problems]}
//   resume <dir> --repo DIR [--branch NAME]
//                                  each task the ledger made -> {ok, reason, base,
//                                  tasks:{id:{branch, head, review, reviews, review_file, merged}}}; head is
//                                  null for a deleted branch, review is the verdict of
//                                  the highest <dir>/review-<id>-<n>.md or null, merged
//                                  is whether the tip is in --branch
//   mutate <worktree> --check CMD --base SHA [--max N] [--ms MS]
//                                  run in a task worktree -> {ok, reason, files, tried,
//                                  caught, discarded, survivors:[{file, line, from, to, diff}],
//                                  stopped, ms, restored}. Small mutations are applied one at a
//                                  time to the lines the task changed (the .js/.mjs files in
//                                  base..HEAD), the task check is re-run on each, and a mutation
//                                  the check does not catch is reported as a survivor with the
//                                  exact mutation as a unified-diff hunk. --max (default 24)
//                                  bounds the number tried and --ms (default 120000) the total
//                                  time budget; the check runs under a per-check timeout so a
//                                  hanging check is stopped. caught is a mutation the check
//                                  failed on (a timeout is not a clean pass), discarded is one
//                                  that does not parse or that the check fails to load, and
//                                  stopped is exhausted, max or time. The worktree is restored
//                                  to clean afterwards (restored).
//
// Source list format: a `## <angle id>` heading per angle, then one bullet per
// source, `- <url> | primary|secondary | <one-line why>`. Anything else is
// ignored. A bullet that is not an http(s) URL is dropped.
//
// Path list format: a `## <angle id>` heading per angle, then one bullet per
// location, `- <path>[:<start>-<end>] | primary|secondary | <one-line why>`;
// the kind defaults to secondary and range is null when absent. A repeated
// path and range is dropped (primary wins); anything else is ignored. ok is
// false when no bullet parses.
//
// Extract format: every quote is a markdown blockquote (`> ...`); adjacent
// `>` lines are one quote, a blank line ends it.
//
// Located quote format: a blockquote whose first line is `path:N` or
// `path:N-M` (optionally in backticks) and whose remaining lines are text
// from that file. It is found when the whitespace-normalized text occurs in
// lines N-M widened by RANGE_MARGIN_LINES; the path is relative to --repo
// (default: the working directory). Other blockquotes are not counted.
//
// Angles format: one bullet per angle, `- <id> | <question>`, where the id is
// letters, digits, `-` or `_`; a repeated id is dropped and anything else is
// ignored. `angles` reads the whole file. `gaps` reads only the bullets under
// a `## Open gaps` heading of a review, up to the next heading, and also
// returns the review's verdict, so one call reads both.
//
// Plan directory, the contract between the plan skill and the implement skill:
//
//   <dir>/plan.md         problem (one paragraph), approach, tasks in merge
//                         order, heavy checks to run once at the end, changes
//                         the plan avoids, open risks
//   <dir>/tasks/<id>.md   one per task
//
// A task file starts with a header of `key: value` lines, in any order, with
// only blank lines before them; the header ends at the first line that is not
// one of these keys, and the rest of the file is the task body:
//
//   id: <id>          letters, digits, `-` or `_`; equals the file name
//   owns: a, b        repository paths the task may change; at least one
//   reads: c, d       repository paths it must read; may be `none`
//   check: <command>  one light check, the rest of the line
//   depends: x, y     ids of tasks that must merge first; may be `none`
//   research: <one question a web searcher can answer>; optional, or `none`
//
// Paths are relative to --repo (default: the working directory), separated by
// commas, backticks stripped, `./` prefixes and trailing slashes removed; a
// directory counts all the files below it, and owning a directory overlaps
// any task that owns a path inside it. Each task in the output carries the
// path of its task file as `file`.
//
// Each estimate comes from the implementer entry of the sizing file, which
// holds measured costs once enough runs exist and shipped defaults before:
// base + k_read * (bytes of owns and reads) / 4 + growth_p90. A file that does
// not exist counts 0, because the task creates it. --sizing defaults to
// $HOME/.pi/agent/recipes/sizing.json, and to base 7000, k_read 1 and
// growth_p90 10000 when that file is absent. Each task carries the bytes its
// estimate used as `bytes`, and the output carries the values as `sizing`.
// --limit defaults to 100000 tokens, under half of the 221184-token window.
// `oversize` lists the ids whose estimate exceeds it. `overlaps` has one [a, b, file] per pair of tasks
// owning the same file, or a directory and a path inside it. `missing` has
// one line per problem: plan.md absent, no tasks, a task whose id is not its
// file name, owns empty, check empty, a depends id with no
// task, or a reads path that neither exists nor is owned by a task.
// `cycles` has one id path per dependency loop, first id repeated at the end.
// ok is true only when all four are empty.
//
// task: checks one implementation task, run in that task's worktree. The
// first line of its report is `done`, `done, concerns`, `blocked: <why>` or
// `failed: <why>` or `handoff: <why>` (the task stopped part way and
// left the rest to a fresh start; never passing). The branch must hold the work as commits and nothing
// uncommitted. base is where the task's own commits start: --base when given,
// and the branch must contain it, else the merge base with --repo's HEAD.
// With --run (and --id) the working directory's worktree is recorded in
// <run>/run.json as kind task when it is a linked worktree. outside lists changed files that are not under --owns,
// whose paths are normalised as in plan. The check is run once with
// `sh -c` in the working directory (--in DIR replaces it for everything the
// gate does); ok needs a passing report, at least one commit, a clean tree, no
// outside files, every commit in base..HEAD made with the configured git
// identity (author and committer; a log that cannot be read is a failure and
// a log line that cannot be parsed counts as a mismatch; skipped when the
// worktree configures no user.email), verify exit 0 and check exit 0, and
// reason names the first failure. --check is optional when --verify is
// given. --verify is run before the check under the same condition (a passing
// report and a HEAD); a command that was not run has exit null. Each command
// may take 10 minutes.
// signature is null when ok; otherwise a hash of the normalised output of the
// command that failed (verify first), or of the normalised reason when no
// command failed. The output is the command's stdout, a `--- stderr ---`
// line and its stderr; the work directory, ANSI escapes, store hashes, temp
// paths, hex runs of 7+ characters, digit runs of 4+ characters, decimal
// numbers and numbers with a time unit are masked,
// so the same failure in another worktree or at another time hashes the same
// while a count that moved (`got 4` to `got 5`) does not. Only the last 20
// lines are hashed.
//
// repro: runs --command with `sh -c` in --in (default the working directory)
// for up to 10 minutes and writes the last 64 KB of its output to
// <dir>/<id>.log (id defaults to `repro`). A linked worktree under <dir> or
// the pi worktree base is recorded in <dir>/run.json as kind repro. --expect
// is fail (the default: ok needs a nonzero exit that is not a timeout) or pass
// (ok needs exit 0). exit is -1 when the command was killed.
//
// hypotheses: a hypothesis is a `## <n>. <claim>` heading and, in its section,
// a `Check first: <text>` line. They are ranked by n; a repeated n is dropped.
// ok needs at least two with both parts. The claim and the check are the
// line's own text after the markers. With --run, a linked worktree under DIR or
// the pi worktree base is recorded as kind hypothesize, and branch and worktree
// are returned.
//
// diagnosis: reads the file a diagnose child writes when a step's output was
// not accepted. From its first `action:` line up to the next heading it takes
// `action:` (continue, retry, fix, replan, next, research or decide), `reason:` (one line),
// `verdict:` (clean or needs-work, for a review that could not be read) and
// `owns:` (extra repository paths a replanned task may change, or none). A
// `## Brief` section holds the instructions for the next worker. ok needs an
// action from --allow (default all seven), a reason, a non-empty brief for fix
// and replan, a question for research, and with --verdict a verdict for
// continue; problem names what is missing. question is the first line of the
// brief (leading `-`, `*`, `>` and spaces removed, at most 300 characters) for
// research and empty otherwise.
//
// integrate: reads the integration worktree at <dir>/integration, <dir>/pr.md
// and the first line of <dir>/heavy.md (`pass`, `none` or `fail: <why>`).
// merged lists the task ids whose branch is an ancestor of its HEAD. ok needs
// every task merged, a clean tree, every commit since the run's pinned base
// made with the configured git identity (a log that cannot be read fails the
// check), a pull request text and heavy checks that passed or were not
// needed. With --tidy yes and ok true it then removes the worktree and
// deletes the branch of every merged task, and prunes stale worktree entries;
// tidied lists those tasks and tidy_problems what it kept.
// It then clears the review and dependency worktrees and the base ref the run
// recorded, leaving the integration branch and any set-aside task worktrees.
// The commit of each branch is written to <dir>/tidied.json before the branch
// is deleted, and a later run checks a missing branch by that commit, so
// running the check again after a tidy gives the same answer. The integrating
// child is shown this command and may well run it before the workflow does.
//
// mutate: runs small mutations against a task's changed lines. The changed
// .js/.mjs files are the ones in `git diff --name-only <base>..HEAD`, minus
// files named `*.test.js` or `*.test.mjs`, and each file's candidate lines are
// the new-side lines of its `git diff -U0` hunks (lines deleted from the old
// side have no new-side line and are skipped). Candidates are taken in turn
// across the files, each file's lines ascending, operators in order, so that no
// single file can spend the whole --max cap. Blank and comment-only lines yield
// no candidate. Each candidate is written to the file, run through
// `node --check` (a failure is a discarded mutation), and, if it parses, the
// task check is run in the worktree under `timeout -k 5 <s> sh -c <check>`
// where <s> is the whole seconds left in the --ms budget (at least 1); a check
// that exits 0 is a survivor, a check that fails to load (SyntaxError, Cannot
// find module, is not defined, ...) is discarded, and any other failure --
// including the timeout 124/137 exit -- is caught. The original text is
// restored after every candidate. --max (default 24) and the deadline checked
// before each candidate bound the run; stopped is max, time or exhausted
// (every candidate tried). The survivors carry the exact mutation as a
// unified-diff hunk with no context. ok is false only for an operational
// failure: the path is not a git worktree, --base is absent or not an ancestor
// of HEAD, a scanned file is left dirty and cannot be restored from HEAD, or
// `node --check` or `timeout` cannot be started.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { abandon, merge, pin, record, where } from "./recipe-git.mjs";

const EXTRACT_CAP_BYTES = 24 * 1024;
// A locator's range is approximate, so a quote a little outside it is still legitimate.
const RANGE_MARGIN_LINES = 10;
const DEFAULT_WINDOW = 221184;
const SYNTH_TOKENS = 70000;
const PR_CHARS = 4000;

class Usage extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Usage(`${argv[i]} needs a value`);
      flags[argv[i].slice(2)] = value;
      i++;
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

function intFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 0) throw new Usage(`--${name} must be a non-negative integer`);
  return n;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (["ENOENT", "EISDIR", "ENOTDIR", "ENAMETOOLONG"].includes(err.code)) return null;
    throw err;
  }
}

function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_")) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

function urls(file) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, urls: [], reason: "file missing" };
  const seen = new Map();
  let angle = "";
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(?:angle:\s*)?(.+?)\s*$/i);
    if (heading) {
      angle = heading[1];
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const [rawUrl, rawKind = "", ...rest] = bullet[1].split("|").map((s) => s.trim());
    const url = normalizeUrl(rawUrl.replace(/^<|>$/g, ""));
    if (!url) continue;
    const kind = rawKind.toLowerCase() === "primary" ? "primary" : "secondary";
    const prior = seen.get(url);
    if (prior) {
      if (kind === "primary") prior.kind = "primary";
    } else seen.set(url, { url, angle, why: rest.join(" | "), kind });
  }
  const list = [...seen.values()];
  return { ok: list.length > 0, urls: list };
}

function countQuotes(text) {
  let quotes = 0;
  let inQuote = false;
  for (const line of text.split("\n")) {
    const body = line.match(/^\s{0,3}>\s?(.*)$/);
    if (body && body[1].trim()) {
      if (!inQuote) quotes++;
      inQuote = true;
    } else if (!body) inQuote = false;
  }
  return quotes;
}

function paths(file) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, paths: [], reason: "file missing" };
  const seen = new Map();
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const [rawPath, rawKind = "", ...rest] = bullet[1].split("|").map((s) => s.trim());
    const loc = rawPath.replace(/^`|`$/g, "").match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
    if (!loc || !loc[1].trim()) continue;
    const range = loc[2] === undefined ? null : { start: Number(loc[2]), end: Number(loc[3] ?? loc[2]) };
    const kind = rawKind.toLowerCase() === "primary" ? "primary" : "secondary";
    const key = `${loc[1]}\0${range ? `${range.start}-${range.end}` : ""}`;
    const prior = seen.get(key);
    if (prior) {
      if (kind === "primary") prior.kind = "primary";
    } else seen.set(key, { path: loc[1], range, why: rest.join(" | "), kind });
  }
  const list = [...seen.values()];
  if (list.length === 0) return { ok: false, paths: [], reason: "no path parsed" };
  return { ok: true, paths: list };
}

// The extractor wraps a passage's location and code in a blockquote, but the
// location line, the backticks and the fence lines are not text to find in
// the file, so they are dropped before a quote is matched against it.
const QUOTE_LOCATION = /^`?[^`:\s]+:\d+(?:-\d+)?`?$/;

function quoteBody(lines) {
  const body = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (i === 0 && QUOTE_LOCATION.test(t)) return;
    if (/^```/.test(t)) return;
    const wrapped = t.match(/^`(.+)`$/);
    body.push(wrapped ? wrapped[1] : t);
  });
  return body;
}

function quoteBlocks(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    const body = line.match(/^\s{0,3}>\s?(.*)$/);
    if (body && body[1].trim()) {
      if (current === null) out.push((current = []));
      current.push(body[1]);
    } else if (!body) current = null;
  }
  return out;
}

const collapse = (lines) => lines.join(" ").replace(/\s+/g, " ").trim();

function quoteTexts(text) {
  return quoteBlocks(text).map((q) => collapse(quoteBody(q)));
}

// A located quote cites its own file and lines; the notes it sits in are
// only trustworthy when its text really is there.
function missingLocated(text, repo) {
  const out = { quotes: 0, missing: [] };
  for (const block of quoteBlocks(text)) {
    const first = block[0].trim();
    if (!QUOTE_LOCATION.test(first)) continue;
    const body = collapse(quoteBody(block));
    if (!body) continue;
    const location = first.replace(/`/g, "");
    const cited = location.match(/^(.*):(\d+)(?:-(\d+))?$/);
    const start = Number(cited[2]);
    const end = cited[3] === undefined ? start : Number(cited[3]);
    out.quotes++;
    let full = null;
    try {
      full = fs.readFileSync(path.resolve(repo, cited[1]), "utf8");
    } catch {
      // any read failure counts as not found
    }
    const haystack =
      full === null
        ? null
        : full
            .split("\n")
            .slice(Math.max(0, start - 1 - RANGE_MARGIN_LINES), end + RANGE_MARGIN_LINES)
            .join(" ")
            .replace(/\s+/g, " ");
    if (haystack === null || !haystack.includes(body)) out.missing.push({ location, quote: body });
  }
  return out;
}

function quotesReason(missing) {
  return `quote not found in its file: ${missing.map((m) => m.location).join(", ")}`;
}

function quotes(file, flags) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, quotes: 0, missing: [], reason: "file missing" };
  const found = missingLocated(text, flags.repo ?? ".");
  const ok = found.missing.length === 0;
  return ok ? { ok, ...found } : { ok, ...found, reason: quotesReason(found.missing) };
}

// An unreadable verdict is left as verdictOf reports it.
function checkQuotes(file, out, flags) {
  if (out.verdict === "invalid") return out;
  const text = readIfExists(file);
  if (text === null) return out;
  const { missing } = missingLocated(text, flags.repo ?? ".");
  if (missing.length === 0) return out;
  return { ...out, clean: false, verdict: "invalid", reason: quotesReason(missing), missing };
}

function extract(file, flags) {
  const cap = intFlag(flags, "cap", EXTRACT_CAP_BYTES);
  let bytes;
  try {
    bytes = fs.statSync(file).size;
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, bytes: 0, quotes: 0, over_cap: false, reason: "file missing" };
    throw err;
  }
  const text = fs.readFileSync(file, "utf8");
  const quotes = countQuotes(text);
  const over_cap = bytes > cap;
  const lines = text.split("\n");
  const headerEnd = lines.findIndex((l) => l.trim() === "" || /^\s{0,3}>/.test(l));
  const header = (headerEnd < 0 ? lines : lines.slice(0, headerEnd)).join("\n");
  const source = header.match(/^File:\s*`?(.+?)`?\s*$/m);
  if (!source) return { ok: quotes > 0 && !over_cap, bytes, quotes, over_cap };
  const named = splitFileHeader(source[1], flags.repo ?? ".");
  const range = header.match(/^Range:\s*(\d+)\s*-\s*(\d+)\s*$/m);
  const ranges = range ? [[Number(range[1]), Number(range[2])]] : named.ranges;
  const full = readIfExists(path.resolve(flags.repo ?? ".", named.path));
  let missing = quoteTexts(text);
  if (full === null) {
    return { ok: false, bytes, quotes, over_cap, file: named.path, missing, reason: "named file missing" };
  }
  const allLines = full.split("\n");
  const fileLines = ranges.length
    ? ranges.flatMap(([start, end]) => allLines.slice(Math.max(0, start - 1 - RANGE_MARGIN_LINES), end + RANGE_MARGIN_LINES))
    : allLines;
  const haystack = fileLines.join(" ").replace(/\s+/g, " ");
  missing = missing.filter((q) => !haystack.includes(q));
  return { ok: quotes > 0 && !over_cap && missing.length === 0, bytes, quotes, over_cap, file: named.path, missing };
}

// A File header is the path alone, but models append "(lines 3-9, 12-20)".
// A path that exists whole wins, so one containing spaces still works.
function splitFileHeader(value, repo) {
  if (readIfExists(path.resolve(repo, value)) !== null) return { path: value, ranges: [] };
  const suffix = value.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  const bare = suffix ? suffix[1] : value;
  const ranges = suffix ? [...suffix[2].matchAll(/(\d+)\s*-\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]) : [];
  const pathOnly = readIfExists(path.resolve(repo, bare)) !== null ? bare : bare.split(/\s/)[0];
  return { path: pathOnly, ranges };
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function size(dir, flags) {
  const window = intFlag(flags, "window", DEFAULT_WINDOW);
  const bytes = dirBytes(dir);
  const est_tokens = Math.ceil(bytes / 4);
  const split = est_tokens <= 0.5 * window ? 1 : Math.max(2, Math.ceil(est_tokens / SYNTH_TOKENS));
  return { bytes, est_tokens, split };
}

const VERDICT_SPAN = 6;

function verdictOf(file) {
  const text = readIfExists(file);
  if (text === null) return { asked: null, sound: null, clean: false, verdict: "invalid", reason: "file missing" };
  if (/^handoff:/i.test(firstLine(text))) return { asked: null, sound: null, clean: false, verdict: "invalid", reason: "handoff" };
  const all = text
    .split("\n")
    .map((l) => l.replace(/^[\s>*`_-]+/, "").replace(/[*`_]+/g, ""))
    .filter((l) => l.trim());
  const start = all.findIndex((l) => /^(Does what was asked|Sound):/i.test(l));
  const lines = [];
  for (let i = start; start >= 0 && i < all.length && i < start + VERDICT_SPAN; i++) {
    if (/^#/.test(all[i])) break;
    lines.push(all[i]);
  }
  const pick = (re) => {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[1].toLowerCase();
    }
    return null;
  };
  // Reviews spell this line "partial" or "partially" as often as "partly".
  const askedRaw = pick(/^Does what was asked:\s*(yes|no|partly|partial|partially)\b/i);
  const asked = askedRaw === "partial" || askedRaw === "partially" ? "partly" : askedRaw;
  const sound = pick(/^Sound:\s*(yes|no)\b/i);
  if (!asked || !sound) return { asked, sound, clean: false, verdict: "invalid" };
  const clean = asked === "yes" && sound === "yes";
  return { asked, sound, clean, verdict: clean ? "clean" : "needs-work" };
}

const PI_WORKTREE_BASE = "/var/tmp/pi-worktrees";

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Abandon removes what is recorded, so only worktrees the run's own tooling
// makes are recorded, never a session's checkout.
function recordable(dir, here) {
  if (!here.linked || !here.worktree) return false;
  const roots = [dir, PI_WORKTREE_BASE, process.env.RECIPE_WORKTREE_ROOT].filter(Boolean);
  return roots.some((r) => inside(realOr(r), here.worktree));
}

function verdict(file, flags) {
  const out = checkQuotes(file, verdictOf(file), flags);
  if (!flags.run) return out;
  const here = where(process.cwd());
  const recorded = recordable(flags.run, here);
  if (recorded) record(flags.run, { kind: "review", id: flags.id, branch: here.branch, worktree: here.worktree });
  return { ...out, branch: here.branch, worktree: here.worktree, recorded };
}

const ANGLE = /^\s*[-*]\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*\|\s*(\S.*?)\s*$/;

function angleBullets(text) {
  const seen = new Set();
  const list = [];
  for (const line of text.split("\n")) {
    const m = line.match(ANGLE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    list.push({ id: m[1], question: m[2] });
  }
  return list;
}

function angles(file) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, angles: [], reason: "file missing" };
  const list = angleBullets(text);
  return { ok: list.length > 0, angles: list };
}

function gaps(file, flags) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, angles: [], clean: false, verdict: "invalid", reason: "file missing" };
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+Open gaps\s*$/i.test(l));
  const section = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      section.push(line);
    }
  }
  const v = checkQuotes(file, verdictOf(file), flags);
  return { ok: v.verdict !== "invalid", angles: angleBullets(section.join("\n")), ...v };
}

const PLAN_LIMIT = 100000;
const SIZING_FALLBACK = { base: 7000, k_read: 1, growth_p90: 10000 };
const TASK_KEYS = ["id", "owns", "reads", "check", "depends", "research"];
const TASK_HEADER = new RegExp(`^(${TASK_KEYS.join("|")}):[ \\t]*(.*?)\\s*$`);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function implementerCost(flags) {
  const explicit = flags.sizing !== undefined;
  const file = explicit ? flags.sizing : path.join(process.env.HOME ?? "", ".pi/agent/recipes/sizing.json");
  const text = explicit ? fs.readFileSync(file, "utf8") : readIfExists(file);
  if (text === null) return SIZING_FALLBACK;
  const entry = JSON.parse(text).roles?.implementer ?? {};
  return {
    base: entry.base ?? SIZING_FALLBACK.base,
    k_read: entry.k_read ?? SIZING_FALLBACK.k_read,
    growth_p90: entry.growth_p90 ?? SIZING_FALLBACK.growth_p90,
  };
}

function repoPath(item) {
  const clean = path.posix.normalize(item.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return clean === "." ? "" : clean;
}

function within(a, b) {
  return a === b || b.startsWith(a + "/") || a.startsWith(b + "/");
}

function pathList(raw, normalize = false) {
  const list = [];
  for (const part of (raw ?? "").split(",")) {
    const bare = part.trim().replace(/^`+|`+$/g, "").trim();
    const item = normalize && bare.toLowerCase() !== "none" ? repoPath(bare) : bare;
    if (item && item.toLowerCase() !== "none" && !list.includes(item)) list.push(item);
  }
  return list;
}

function parseTask(text) {
  const header = {};
  let started = false;
  for (const line of text.split("\n")) {
    if (!line.trim() && !started) continue;
    const m = line.match(TASK_HEADER);
    if (!m) break;
    started = true;
    if (!(m[1] in header)) header[m[1]] = m[2];
  }
  return header;
}

function pathBytes(repo, rel) {
  try {
    const full = path.resolve(repo, rel);
    const st = fs.statSync(full);
    return st.isDirectory() ? dirBytes(full) : st.size;
  } catch (err) {
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(err.code)) return 0;
    throw err;
  }
}

function findCycles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const cycles = [];
  const visit = (id, trail) => {
    state.set(id, 1);
    for (const dep of byId.get(id).depends) {
      if (!byId.has(dep)) continue;
      if (state.get(dep) === 1) cycles.push([...trail.slice(trail.indexOf(dep)), dep]);
      else if (!state.has(dep)) visit(dep, [...trail, dep]);
    }
    state.set(id, 2);
  };
  for (const t of tasks) if (!state.has(t.id)) visit(t.id, [t.id]);
  return cycles;
}

function plan(dir, flags) {
  const repo = flags.repo ?? process.cwd();
  const limit = intFlag(flags, "limit", PLAN_LIMIT);
  const cost = implementerCost(flags);
  const missing = [];
  if (readIfExists(path.join(dir, "plan.md")) === null) missing.push("plan.md");

  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, "tasks")).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    if (!["ENOENT", "ENOTDIR"].includes(err.code)) throw err;
  }
  if (names.length === 0) missing.push("no tasks");

  const tasks = names.map((name) => {
    const stem = name.slice(0, -3);
    const h = parseTask(fs.readFileSync(path.join(dir, "tasks", name), "utf8"));
    if (h.id !== stem || !TASK_ID.test(stem)) missing.push(`${stem}: id must be the file name`);
    const task = {
      id: stem,
      file: path.join(dir, "tasks", name),
      owns: pathList(h.owns, true),
      reads: pathList(h.reads, true),
      check: h.check ?? "",
      depends: pathList(h.depends),
      research: /^none$/i.test(h.research ?? "") ? "" : (h.research ?? ""),
    };
    if (task.owns.length === 0) missing.push(`${stem}: owns`);
    if (!task.check) missing.push(`${stem}: check`);
    return task;
  });

  const ids = new Set(tasks.map((t) => t.id));
  const owned = tasks.flatMap((t) => t.owns);
  const overlaps = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      for (const a of tasks[i].owns) {
        for (const b of tasks[j].owns) {
          if (within(a, b)) overlaps.push([tasks[i].id, tasks[j].id, a.length >= b.length ? a : b]);
        }
      }
    }
  }

  const oversize = [];
  for (const t of tasks) {
    for (const dep of t.depends) if (!ids.has(dep)) missing.push(`${t.id}: depends on unknown task ${dep}`);
    for (const file of t.reads) {
      if (!owned.some((o) => within(o, file)) && !fs.existsSync(path.resolve(repo, file))) missing.push(`${t.id}: reads ${file}, which does not exist`);
    }
    const bytes = [...new Set([...t.owns, ...t.reads])].reduce((sum, f) => sum + pathBytes(repo, f), 0);
    t.bytes = bytes;
    t.est = Math.ceil(cost.base + (cost.k_read * bytes) / 4 + cost.growth_p90);
    if (t.est > limit) oversize.push(t.id);
  }

  const cycles = findCycles(tasks);
  const ok = oversize.length === 0 && overlaps.length === 0 && cycles.length === 0 && missing.length === 0;
  return { ok, tasks, sizing: cost, oversize, overlaps, missing, cycles };
}

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 1500;
const LIST_CAP = 50;
const REPORT_HEAD = /^(done, concerns|done|blocked|failed|handoff)\b:?\s*(.*)$/i;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^[\s>*`_-]+/, "").replace(/[*`_]+/g, "").trim();
}

function reportStatus(file) {
  const text = readIfExists(file);
  if (text === null) return { status: "missing", why: "report missing" };
  const line = firstLine(text);
  const m = line.match(REPORT_HEAD);
  if (!m) return { status: "invalid", why: line.slice(0, 200) };
  return { status: m[1].toLowerCase(), why: m[2].trim() };
}

function owned(file, owns) {
  return owns.some((o) => file === o || file.startsWith(`${o}/`));
}

const SIGNATURE_LINES = 20;
const STDERR_MARKER = "--- stderr ---";
const RUN_BUFFER = 256 * 1024 * 1024;

function signatureOf(text, roots) {
  let t = text;
  for (const root of [...new Set(roots)].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(root).join("<wt>");
  t = t
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\/nix\/store\/[0-9a-z]{32}-/g, "/nix/store/")
    .replace(/\/(?:var\/)?tmp\/\S*/g, "<tmp>")
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/\d+(?:\.\d+)?\s*(?:ms|us|µs|s|m|h)\b/g, "<t>")
    .replace(/\d+\.\d+/g, "<n>")
    .replace(/\d+(?=\s*duration)|\bduration\S*\s+\d+/g, "<t>")
    .replace(/\d{4,}/g, "0");
  const lines = t
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-SIGNATURE_LINES);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// The signature covers the full output; the tail is only for display.
function runCommand(cwd, command) {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: RUN_BUFFER });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return {
    exit: r.status ?? -1,
    timed_out: r.error?.code === "ETIMEDOUT",
    overflowed: r.error?.code === "ENOBUFS",
    output: `${stdout}${stderr}`,
    signature: signatureOf(`${stdout}\n${STDERR_MARKER}\n${stderr}`, [cwd, realOr(cwd)]),
  };
}

// A commit made with an identity other than the worktree's configured one is
// not attributed to the repository's account on the host, so a gate that
// only looks at the working tree would let it reach a pull request.
function commitIdentities(cwd, range) {
  const email = git(cwd, ["config", "user.email"]);
  const name = git(cwd, ["config", "user.name"]);
  if (!email) return { expected: null, mismatched: [], unreadable: false };
  const expected = { name: name ?? null, email };
  const log = git(cwd, ["log", "--format=%h %an <%ae> %cn <%ce>", range]);
  if (log === null) return { expected, mismatched: [], unreadable: true };
  // An empty name or email is legal (`git -c user.email= commit` succeeds),
  // so each field may be empty, and a line that still does not parse is a
  // mismatch, since it cannot be judged.
  const matches = (n, e) => e === email && (!name || n === name);
  const mismatched = [];
  for (const line of log.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(\S+) (.*?) <(.*?)> (.*?) <([^<>]*)>$/);
    if (!m) {
      mismatched.push(line);
      continue;
    }
    const nameA = m[2].trim();
    const nameC = m[4].trim();
    if (!matches(nameA, m[3]) || !matches(nameC, m[5])) mismatched.push(`${m[1]} ${nameA} <${m[3]}>`);
  }
  return { expected, mismatched, unreadable: false };
}

const identityLabel = ({ name, email }) => (name ? `${name} <${email}>` : email);

function task(report, flags) {
  if (!flags.check && !flags.verify) throw new Usage("task needs --check or --verify");
  const cwd = flags.in ?? process.cwd();
  const owns = pathList(flags.owns, true);
  const rep = reportStatus(report);
  const passing = rep.status === "done" || rep.status === "done, concerns";

  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const worktree = git(cwd, ["rev-parse", "--show-toplevel"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const source = flags.repo ? git(flags.repo, ["rev-parse", "HEAD"]) : null;
  const pinned = flags.base ? (git(cwd, ["rev-parse", "--verify", "-q", `${flags.base}^{commit}`]) ?? flags.base) : null;
  const base = pinned ?? (head && source ? git(cwd, ["merge-base", "HEAD", source]) : null);
  const fromBase = !pinned || spawnSync("git", ["merge-base", "--is-ancestor", pinned, "HEAD"], { cwd }).status === 0;
  if (flags.run && head) {
    const here = where(cwd);
    if (recordable(flags.run, here)) record(flags.run, { kind: "task", id: flags.id, branch: here.branch, worktree: here.worktree });
  }

  const commits = base && fromBase ? Number(git(cwd, ["rev-list", "--count", `${base}..HEAD`])) : 0;
  const changed = base && fromBase ? (git(cwd, ["diff", "--name-only", base, "HEAD"]) ?? "").split("\n").filter(Boolean) : [];
  const clean = git(cwd, ["status", "--porcelain"]) === "";
  const outside = owns.length ? changed.filter((f) => !owned(f, owns)) : [];
  const identity = base && fromBase ? commitIdentities(cwd, `${base}..HEAD`) : { expected: null, mismatched: [], unreadable: false };

  const check = { command: flags.check ?? null, exit: null, tail: "", signature: null };
  const verify = flags.verify ? { command: flags.verify, exit: null, tail: "", signature: null } : null;
  const execute = (slot) => {
    const r = runCommand(cwd, slot.command);
    slot.exit = r.exit;
    slot.tail = r.output.slice(-TAIL_CHARS);
    if (r.exit !== 0) slot.signature = r.signature;
  };
  if (passing && head) {
    if (verify) execute(verify);
    if (check.command && (!verify || verify.exit === 0)) execute(check);
  }

  let reason = "";
  if (!passing) reason = `report ${rep.status}: ${rep.why}`;
  else if (!head || !branch || branch === "HEAD") reason = "not on a branch of a git worktree";
  else if (!base) reason = "no base commit: pass --repo of the source checkout";
  else if (!fromBase) reason = `branch does not start from the run's base ${base}`;
  else if (commits === 0) reason = "no commits on the branch";
  else if (!clean) reason = "uncommitted changes in the worktree";
  else if (outside.length) reason = `changed files outside owns: ${outside.slice(0, LIST_CAP).join(", ")}`;
  else if (identity.unreadable) reason = `commits could not be read: git log ${base}..HEAD failed`;
  else if (identity.mismatched.length)
    reason = `commits not made with the configured git identity ${identityLabel(identity.expected)}: ${identity.mismatched.slice(0, LIST_CAP).join(", ")}`;
  else if (verify && verify.exit !== 0) reason = `verify failed (exit ${verify.exit}): ${verify.tail}`;
  else if (check.command && check.exit !== 0) reason = `check failed (exit ${check.exit}): ${check.tail}`;

  let signature = null;
  if (reason !== "") signature = verify?.signature ?? check.signature ?? signatureOf(reason, []);

  return {
    ok: reason === "",
    reason,
    report: rep,
    branch,
    worktree,
    head,
    base,
    clean,
    commits,
    identity,
    files: changed.slice(0, LIST_CAP),
    outside: outside.slice(0, LIST_CAP),
    check,
    verify,
    signature,
  };
}

const REPRO_LOG_BYTES = 64 * 1024;

function repro(dir, flags) {
  if (!flags.command) throw new Usage("repro needs --command");
  const expect = flags.expect ?? "fail";
  if (expect !== "fail" && expect !== "pass") throw new Usage("--expect must be fail or pass");
  const id = flags.id ?? "repro";
  const cwd = flags.in ?? process.cwd();
  const r = runCommand(cwd, flags.command);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `${id}.log`);
  fs.writeFileSync(log, r.output.slice(-REPRO_LOG_BYTES));
  const here = where(cwd);
  if (recordable(dir, here)) record(dir, { kind: "repro", id, branch: here.branch, worktree: here.worktree });
  let reason = "";
  if (r.timed_out) reason = "the command did not finish in 10 minutes";
  else if (r.overflowed) reason = "the command printed more output than can be captured";
  else if (expect === "fail" && r.exit === 0) reason = "the command passed (exit 0) but was expected to fail";
  else if (expect === "pass" && r.exit !== 0) reason = `the command failed (exit ${r.exit}) but was expected to pass`;
  return {
    ok: reason === "",
    reason,
    command: flags.command,
    expect,
    exit: r.exit,
    timed_out: r.timed_out,
    tail: r.output.slice(-TAIL_CHARS),
    signature: r.signature,
    log,
    branch: here.branch,
    worktree: here.worktree,
    head: git(cwd, ["rev-parse", "HEAD"]),
  };
}

function hypotheses(file, flags = {}) {
  const out = hypothesesOf(file);
  if (!flags.run) return out;
  const here = where(process.cwd());
  if (recordable(flags.run, here)) record(flags.run, { kind: "hypothesize", id: flags.id, branch: here.branch, worktree: here.worktree });
  return { ...out, branch: here.branch, worktree: here.worktree };
}

function hypothesesOf(file) {
  const text = readIfExists(file);
  if (text === null) return { ok: false, hypotheses: [], problem: "file missing" };
  const lines = text.split("\n").map((l) => l.replace(/^[\s>*-]+/, "").trim());
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(\d+)\.\s*(.*?)\s*$/);
    if (!m) continue;
    const rank = Number(m[1]);
    let check = "";
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) {
      const c = lines[j].match(/^(?:\*\*|__)?Check first:?(?:\*\*|__)?:?\s*(.*?)\s*$/i);
      if (c) {
        check = c[1];
        break;
      }
    }
    if (!found.has(rank)) found.set(rank, { rank, claim: m[2], check });
  }
  const list = [...found.values()].filter((h) => h.claim && h.check).sort((a, b) => a.rank - b.rank);
  const ok = list.length >= 2;
  return { ok, hypotheses: list, problem: ok ? null : "fewer than two hypotheses with a Check first line" };
}

function heavyCheck(file) {
  const text = readIfExists(file);
  if (text === null) return "not recorded";
  const line = firstLine(text);
  if (/^pass\b/i.test(line)) return "pass";
  if (/^none\b/i.test(line)) return "none";
  const fail = line.match(/^fail\w*\b:?\s*(.*)$/i);
  return fail ? `fail: ${fail[1]}` : "not recorded";
}

function integrate(dir, flags) {
  const worktree = path.join(dir, "integration");
  const pairs = (flags.tasks ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)]);
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const recordFile = path.join(dir, "tidied.json");
  const tidied = JSON.parse(readIfExists(recordFile) ?? "{}");
  const isMerged = ([, b]) => {
    const tip = branchTip(worktree, b) ?? tidied[b];
    return Boolean(tip) && spawnSync("git", ["merge-base", "--is-ancestor", tip, "HEAD"], { cwd: worktree }).status === 0;
  };
  const merged = head ? pairs.filter(isMerged).map(([id]) => id) : [];
  const unmerged = pairs.map(([id]) => id).filter((id) => !merged.includes(id));
  const clean = head ? git(worktree, ["status", "--porcelain"]) === "" : false;
  const pr_text = (readIfExists(path.join(dir, "pr.md")) ?? "").trim().slice(0, PR_CHARS);
  const heavy_check = heavyCheck(path.join(dir, "heavy.md"));
  const pinned = JSON.parse(readIfExists(path.join(dir, "run.json")) ?? "null")?.base ?? null;

  const reasons = [];
  if (!head) reasons.push("no integration worktree");
  else if (flags.branch && branch !== flags.branch) reasons.push(`integration worktree is on ${branch}, not ${flags.branch}`);
  if (unmerged.length) reasons.push(`not merged: ${unmerged.join(", ")}`);
  if (head && !clean) reasons.push("uncommitted changes in the integration worktree");
  if (head && pinned) {
    const identity = commitIdentities(worktree, `${pinned}..HEAD`);
    if (identity.unreadable) reasons.push(`commits could not be read: git log ${pinned}..HEAD failed`);
    else if (identity.mismatched.length)
      reasons.push(`commits not made with the configured git identity ${identityLabel(identity.expected)}: ${identity.mismatched.slice(0, LIST_CAP).join(", ")}`);
  }
  if (!pr_text) reasons.push("pr.md missing or empty");
  if (heavy_check !== "pass" && heavy_check !== "none") reasons.push(`heavy checks: ${heavy_check}`);
  const ok = reasons.length === 0;
  const out = { ok, reasons, branch, head, merged, unmerged, clean, heavy_check, pr_text };
  if (flags.tidy === "yes" && ok) {
    Object.assign(out, tidy(worktree, pairs.filter(([id]) => merged.includes(id)), recordFile, tidied));
    const swept = abandon(dir, { kinds: ["review", "deps", "base"] });
    out.tidy_problems.push(...swept.problems);
    out.left_over = swept.left;
  }
  return out;
}

// Removes the worktree and the branch of every task merged into the
// integration branch. `branch -d` refuses a branch that is not merged, so
// nothing unmerged is lost. A branch already gone was tidied by an earlier
// run, since integrate only passes it here when record holds its commit.
function tidy(cwd, pairs, recordFile, record) {
  const listing = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" }).stdout || "";
  const where = {};
  let current = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice(9);
    else if (line.startsWith("branch refs/heads/") && current) where[line.slice(18)] = current;
  }
  const tidied = [];
  const tidy_problems = [];
  for (const [id, b] of pairs) {
    const tip = branchTip(cwd, b);
    if (!tip) {
      tidied.push(id);
      continue;
    }
    if (where[b]) {
      const r = spawnSync("git", ["worktree", "remove", where[b]], { cwd, encoding: "utf8" });
      if (r.status !== 0) {
        tidy_problems.push(`${id}: worktree ${where[b]} kept: ${(r.stderr || "").trim().split("\n")[0]}`);
        continue;
      }
    }
    record[b] = tip;
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
    const d = spawnSync("git", ["branch", "-d", b], { cwd, encoding: "utf8" });
    if (d.status !== 0) tidy_problems.push(`${id}: branch ${b} kept: ${(d.stderr || "").trim().split("\n")[0]}`);
    else tidied.push(id);
  }
  spawnSync("git", ["worktree", "prune"], { cwd });
  return { tidied, tidy_problems };
}

function branchTip(cwd, b) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`]);
}

function resume(dir, flags) {
  const ledger = JSON.parse(readIfExists(path.join(dir, "run.json")) ?? "null");
  if (!ledger) return { ok: false, reason: "no ledger", base: null, tasks: {} };
  const repo = flags.repo ?? ".";
  const target = flags.branch ? branchTip(repo, flags.branch) : null;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const tidied = JSON.parse(readIfExists(path.join(dir, "tidied.json")) ?? "{}");
  const tasks = {};
  for (const m of ledger.made ?? []) {
    if (m.kind !== "task" || !m.id) continue;
    const head = branchTip(repo, m.branch);
    const escaped = m.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^review-${escaped}-(\\d+)(\\.merged)?\\.md$`);
    const byN = new Map();
    for (const f of files) {
      const m = pattern.exec(f);
      if (!m) continue;
      const n = Number(m[1]);
      const prior = byN.get(n);
      if (!prior || m[2]) byN.set(n, [f, m[1]]);
    }
    const seen = [...byN.keys()].sort((a, b) => b - a);
    const usable = seen.find((n) => {
      const [f] = byN.get(n);
      return !/^handoff:/i.test(firstLine(readIfExists(path.join(dir, f)) ?? ""));
    });
    const latest = usable === undefined ? null : byN.get(usable);
    const highest = seen.length ? seen[0] : 0;
    const inTarget = Boolean(head && target) && spawnSync("git", ["merge-base", "--is-ancestor", head, target], { cwd: repo }).status === 0;
    tasks[m.id] = {
      branch: m.branch,
      head,
      review: latest ? verdictOf(path.join(dir, latest[0])).verdict : null,
      reviews: highest,
      review_file: latest ? path.join(dir, latest[0]) : null,
      merged: inTarget || (!head && Boolean(tidied[m.branch])),
    };
  }
  return { ok: true, reason: null, base: ledger.base ?? null, tasks };
}

function ownsList(raw) {
  const list = [];
  for (const part of String(raw).split(",")) {
    const bare = part.trim().replace(/^`+|`+$/g, "").trim();
    if (!bare || /^none$/i.test(bare)) continue;
    const clean = path.posix.normalize(bare.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (clean && clean !== "." && !list.includes(clean)) list.push(clean);
  }
  return list;
}

const ACTIONS = ["continue", "retry", "fix", "replan", "next", "research", "decide"];
const DIAGNOSIS_KEY = /^(action|reason|verdict|owns):[ \t]*(.*?)\s*$/i;

function diagnosis(file, flags) {
  const allowed = flags.allow ? String(flags.allow).split(",").map((a) => a.trim()) : ACTIONS;
  const text = readIfExists(file);
  const none = { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false, question: "" };
  if (text === null) return { ...none, problem: "file missing" };
  const lines = text.split("\n").map((l) => l.replace(/^[\s>*`_-]+/, "").replace(/[*`_]+/g, ""));
  const fields = {};
  let start = lines.findIndex((l) => /^action:/i.test(l));
  for (let i = start; start >= 0 && i < lines.length && !/^#/.test(lines[i]); i++) {
    const m = lines[i].match(DIAGNOSIS_KEY);
    if (m && !(m[1].toLowerCase() in fields)) fields[m[1].toLowerCase()] = m[2];
  }
  const briefAt = text.search(/^##\s+Brief\s*$/im);
  const briefText = briefAt >= 0 ? text.slice(briefAt).replace(/^##\s+Brief\s*$/im, "").split(/^##\s/m)[0] : "";
  const brief = briefText.trim().length > 0;
  const first = briefText.split("\n").find((l) => l.trim()) ?? "";
  const asked = first.replace(/^[-*>\s]+/, "").trim().slice(0, 300);
  const action = (fields.action || "").toLowerCase().split(/\s/)[0] || null;
  const verdictWord = (fields.verdict || "").toLowerCase().match(/^(clean|needs-work)\b/);
  const out = {
    ok: true,
    action,
    reason: fields.reason || "",
    verdict: verdictWord ? verdictWord[1] : null,
    owns: fields.owns ? ownsList(fields.owns) : [],
    brief,
    question: action === "research" ? asked : "",
  };
  let problem = null;
  if (!action) problem = "no action line";
  else if (!ACTIONS.includes(action)) problem = `unknown action ${action}`;
  else if (!allowed.includes(action)) problem = `action ${action} is not allowed here (${allowed.join(", ")})`;
  else if (!out.reason) problem = "no reason line";
  else if ((action === "fix" || action === "replan") && !brief) problem = `action ${action} needs a ## Brief section`;
  else if (action === "research" && !out.question) problem = "action research needs a question as the first line of ## Brief";
  else if (action === "continue" && flags.verdict && !out.verdict) problem = "action continue needs a verdict line";
  return problem ? { ...out, ok: false, problem } : out;
}

const PARSE_CHECK_MS = 30 * 1000;
const DISCARD_MARKERS = [
  "SyntaxError",
  "Unexpected token",
  "Cannot find module",
  "Cannot find package",
  "ERR_MODULE_NOT_FOUND",
  "Unknown file extension",
  "is not defined",
];

function gitRaw(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

function firstReplace(line, regex, replacement) {
  const m = regex.exec(line);
  if (!m) return null;
  return line.slice(0, m.index) + replacement + line.slice(m.index + m[0].length);
}

function firstInt(line) {
  const m = /(?<![\w.])(\d+)(?![\w.])/.exec(line);
  return m ? { index: m.index, digits: m[1], value: Number(m[1]) } : null;
}

function intOp(line, delta, positiveOnly) {
  const it = firstInt(line);
  if (!it) return null;
  if (positiveOnly && it.value <= 0) return null;
  return line.slice(0, it.index) + String(it.value + delta) + line.slice(it.index + it.digits.length);
}

function removeNegation(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "!") continue;
    if (line[i + 1] === "=") continue; // != is a comparison, not a negation
    let j = i - 1;
    while (j >= 0 && (line[j] === " " || line[j] === "\t")) j--;
    if (j < 0) return line.slice(0, i) + line.slice(i + 1);
    const c = line[j];
    if (c === "(" || c === "," || c === "=" || c === "&" || c === "|") return line.slice(0, i) + line.slice(i + 1);
  }
  return null;
}

const MUTATE_OPS = [
  (l) => firstReplace(l, /(?<![=!])==(?!=)/, "!="),
  (l) => firstReplace(l, /(?<![=])===/, "!=="),
  (l) => firstReplace(l, /!==/, "==="),
  (l) => firstReplace(l, /&&/, "||"),
  (l) => firstReplace(l, /\|\|/, "&&"),
  (l) => firstReplace(l, /(?<!=)>(?!=)/, "<"),
  (l) => firstReplace(l, /<(?!=)/, ">"),
  (l) => firstReplace(l, /<=/, ">="),
  (l) => firstReplace(l, />=/, "<="),
  (l) => firstReplace(l, /\btrue\b/, "false"),
  (l) => firstReplace(l, /\bfalse\b/, "true"),
  (l) => removeNegation(l),
  (l) => intOp(l, 1, false),
  (l) => intOp(l, -1, true),
  (l) => firstReplace(l, /\+\+/, "--"),
  (l) => firstReplace(l, /--/, "++"),
];

function commentOrBlank(line) {
  const t = line.trim();
  if (t === "") return true;
  return /^\/\//.test(t) || /^\/\*/.test(t) || /^\*/.test(t);
}

function candidateLines(line) {
  if (commentOrBlank(line)) return [];
  const out = [];
  const seen = new Set();
  const push = (to) => {
    if (to === null || to === line || seen.has(to)) return;
    seen.add(to);
    out.push(to);
  };
  for (const op of MUTATE_OPS) push(op(line));
  push("");
  return out;
}

function changedNewLines(worktree, base, file) {
  const out = gitRaw(worktree, ["diff", "-U0", base, "HEAD", "--", file]).out;
  const res = [];
  let pos = null;
  for (const l of out.split("\n")) {
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      pos = { next: Number(m[1]) };
      continue;
    }
    if (!pos) continue;
    if (l.startsWith("+")) {
      res.push({ line: pos.next, text: l.slice(1) });
      pos.next++;
    } else if (l.startsWith(" ")) pos.next++;
  }
  return res.sort((a, b) => a.line - b.line);
}

function diffHunk(file, line, from, to) {
  const h = [`--- a/${file}`, `+++ b/${file}`];
  if (to === "") h.push(`@@ -${line} +${line - 1},0 @@`, `-${from}`);
  else h.push(`@@ -${line} +${line} @@`, `-${from}`, `+${to}`);
  return h.join("\n") + "\n";
}

function mutate(worktree, flags) {
  if (!flags.check) throw new Usage("mutate needs --check");
  const max = intFlag(flags, "max", 24);
  const budgetMs = intFlag(flags, "ms", 120000);
  const start = Date.now();
  const remaining = () => budgetMs - (Date.now() - start);

  const result = { ok: true, reason: "", files: [], tried: 0, caught: 0, discarded: 0, survivors: [], stopped: "exhausted", ms: 0, restored: true };
  const finish = (reason = "") => {
    if (reason) {
      result.ok = false;
      result.reason = reason;
    }
    result.ms = Date.now() - start;
    return result;
  };

  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: worktree, encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true" || gitRaw(worktree, ["rev-parse", "HEAD"]).status !== 0)
    return finish("not a git worktree");
  if (!flags.base) return finish("no --base");
  const baseRef = gitRaw(worktree, ["rev-parse", "--verify", "-q", `${flags.base}^{commit}`]);
  if (baseRef.status !== 0) return finish(`no --base commit ${flags.base}`);
  if (spawnSync("git", ["merge-base", "--is-ancestor", baseRef.out, "HEAD"], { cwd: worktree }).status !== 0)
    return finish(`base ${baseRef.out} is not an ancestor of HEAD`);

  // --diff-filter=d: a deleted file has no new-side lines to mutate.
  const changed = gitRaw(worktree, ["diff", "--diff-filter=d", "--name-only", baseRef.out, "HEAD"]).out.split("\n").filter(Boolean);
  const files = changed.filter((f) => /\.m?js$/.test(f) && !/\.test\.m?js$/.test(f));
  result.files = files;

  // The tree is clean at entry, so each file's text is read once and restored
  // to that exact text after every candidate.
  const original = new Map();
  const readOriginal = (file) => {
    if (!original.has(file)) original.set(file, fs.readFileSync(path.join(worktree, file), "utf8"));
    return original.get(file);
  };
  const restore = (file) => fs.writeFileSync(path.join(worktree, file), original.get(file));
  const runCheck = () => {
    const secs = Math.max(1, Math.floor(remaining() / 1000));
    const r = spawnSync("timeout", ["-k", "5", String(secs), "sh", "-c", flags.check], {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: RUN_BUFFER,
    });
    return { error: r.error ?? null, status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  // A single file must not be able to spend the whole --max cap.
  const perFile = [];
  const lines = new Map();
  for (const file of files) {
    const origLines = readOriginal(file).split("\n");
    lines.set(file, origLines);
    const list = [];
    for (const { line } of changedNewLines(worktree, baseRef.out, file)) {
      const from = origLines[line - 1];
      if (from === undefined) continue;
      for (const to of candidateLines(from)) list.push({ file, line, from, to });
    }
    perFile.push(list);
  }
  const order = [];
  for (let i = 0; ; i++) {
    let more = false;
    for (const list of perFile) {
      const cand = list[i];
      if (!cand) continue;
      more = true;
      order.push(cand);
    }
    if (!more) break;
  }

  let stopReason = "exhausted";
  for (const { file, line, from, to } of order) {
    if (remaining() <= 0) {
      stopReason = "time";
      break;
    }
    if (result.tried >= max) {
      stopReason = "max";
      break;
    }
    result.tried++;
    try {
      const newLines = [...lines.get(file)];
      if (to === "") newLines.splice(line - 1, 1);
      else newLines[line - 1] = to;
      fs.writeFileSync(path.join(worktree, file), newLines.join("\n"));
      const parse = spawnSync(process.execPath, ["--check", file], { cwd: worktree, encoding: "utf8", timeout: PARSE_CHECK_MS });
      if (parse.error) return finish(`node --check could not run: ${parse.error.code}`);
      if (parse.status !== 0) result.discarded++;
      else {
        const cr = runCheck();
        if (cr.error) return finish(`timeout could not run: ${cr.error.code}`);
        if (cr.status === 0) result.survivors.push({ file, line, from, to, diff: diffHunk(file, line, from, to) });
        else if (cr.status !== 124 && cr.status !== 137 && DISCARD_MARKERS.some((m) => cr.out.includes(m))) result.discarded++;
        else result.caught++;
      }
    } finally {
      restore(file);
    }
  }
  result.stopped = stopReason;

  // Only the scanned files matter here: the check may leave untracked files
  // or edit files the task did not touch.
  const scannedDirty = () => gitRaw(worktree, ["status", "--porcelain", ...(files.length ? ["--", ...files] : [])]).out;
  let dirty = scannedDirty();
  if (dirty !== "") {
    for (const file of files) spawnSync("git", ["checkout", "--", file], { cwd: worktree });
    dirty = scannedDirty();
  }
  if (dirty !== "") {
    result.restored = false;
    return finish("the worktree was left dirty");
  }
  return finish();
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const target = positional[0];
  if (!cmd || target === undefined) throw new Usage("usage: recipe-gate urls|paths|extract|quotes|size|verdict|angles|gaps|diagnosis|plan|task|repro|hypotheses|pin|merge|abandon|integrate|resume|mutate <path> [flags]");
  switch (cmd) {
    case "urls":
      return urls(target);
    case "paths":
      return paths(target);
    case "extract":
      return extract(target, flags);
    case "quotes":
      return quotes(target, flags);
    case "size":
      return size(target, flags);
    case "verdict":
      return verdict(target, flags);
    case "angles":
      return angles(target);
    case "gaps":
      return gaps(target, flags);
    case "diagnosis":
      return diagnosis(target, flags);
    case "plan":
      return plan(target, flags);
    case "task":
      return task(target, flags);
    case "repro":
      return repro(target, flags);
    case "hypotheses":
      return hypotheses(target, flags);
    case "pin":
      return pin(target, { repo: flags.repo });
    case "merge":
      return merge(target, { dir: flags.dir, branch: flags.branch, onto: flags.onto, tips: flags.tips, check: flags.check, kind: flags.kind, id: flags.id, refresh: flags.refresh === "yes" });
    case "abandon":
      return abandon(target, { keep: flags.keep });
    case "integrate":
      return integrate(target, flags);
    case "resume":
      return resume(target, flags);
    case "mutate":
      return mutate(target, flags);
    default:
      throw new Usage(`unknown subcommand ${cmd}`);
  }
}

try {
  process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + "\n");
} catch (err) {
  process.stderr.write(`recipe-gate: ${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
