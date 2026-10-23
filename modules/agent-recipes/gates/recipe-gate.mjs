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
//                                  (and optional `Range: <start>-<end>`) comes
//                                  from a repository file: every quote must
//                                  appear, whitespace-normalized, in that file
//                                  (in those lines when a range is given), the
//                                  path is relative to --repo (default: the
//                                  working directory), and the output gains
//                                  file and missing:[quote]; ok also needs
//                                  missing to be empty
//   size <dir> [--window N]        {bytes, est_tokens, split}; N defaults to 221184
//   verdict <review.md> [--run DIR --id ID]
//                                  {asked, sound, clean, verdict}; read from the
//                                  first verdict line and the few lines after
//                                  it, up to the next heading. With --run the
//                                  working directory's linked worktree is
//                                  recorded in <DIR>/run.json as kind review
//                                  and the output gains branch and worktree
//   angles <file>                  angle list -> {ok, angles:[{id, question}]}
//   gaps <review.md>               {ok, angles:[{id, question}], asked, sound, clean, verdict}
//   diagnosis <file> [--allow a,b] [--verdict yes]
//                                  {ok, action, reason, verdict, owns:[], brief, problem}
//   plan <dir> [--sizing FILE] [--repo DIR] [--limit N]
//                                  plan directory -> {ok, tasks:[{id, owns, reads,
//                                  check, depends, research, est}], oversize:[id],
//                                  overlaps:[[a, b, file]], missing:[text],
//                                  cycles:[[id, ...]]}
//   task <report> --check CMD [--owns a,b] [--repo DIR] [--base SHA] [--run DIR --id ID]
//                                  run in a task worktree -> {ok, reason, report:{status,
//                                  why}, branch, worktree, head, base, clean, commits,
//                                  files, outside, check:{command, exit, tail}}
//   pin <dir> --repo DIR           fix the run's base commit and ref in <dir>/run.json ->
//                                  {ok, reason, repo, base, base_ref, reused}
//   merge <worktree> --dir DIR --branch NAME [--tips id:branch,...] [--onto REF]
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
//                                  tasks:{id:{branch, head, review, merged}}}; head is
//                                  null for a deleted branch, review is the verdict of
//                                  the highest <dir>/review-<id>-<n>.md or null, merged
//                                  is whether the tip is in --branch
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
// growth_p90 10000 when that file is absent. --limit defaults to 100000
// tokens, under half of the 221184-token window. `oversize` lists the ids
// whose estimate exceeds it. `overlaps` has one [a, b, file] per pair of tasks
// owning the same file, or a directory and a path inside it. `missing` has
// one line per problem: plan.md absent, no tasks, a task whose id is not its
// file name, owns empty, check empty, a depends id with no
// task, or a reads path that neither exists nor is owned by a task.
// `cycles` has one id path per dependency loop, first id repeated at the end.
// ok is true only when all four are empty.
//
// task: checks one implementation task, run in that task's worktree. The
// first line of its report is `done`, `done, concerns`, `blocked: <why>` or
// `failed: <why>`. The branch must hold the work as commits and nothing
// uncommitted. base is where the task's own commits start: --base when given,
// and the branch must contain it, else the merge base with --repo's HEAD.
// With --run (and --id) the working directory's worktree is recorded in
// <run>/run.json as kind task when it is a linked worktree. outside lists changed files that are not under --owns,
// whose paths are normalised as in plan. The check is run once with
// `sh -c` in the working directory; ok needs a passing report, at least one
// commit, a clean tree, no outside files and check exit 0, and reason names
// the first failure.
//
// diagnosis: reads the file a diagnose child writes when a step's output was
// not accepted. From its first `action:` line up to the next heading it takes
// `action:` (continue, retry, fix, replan or decide), `reason:` (one line),
// `verdict:` (clean or needs-work, for a review that could not be read) and
// `owns:` (extra repository paths a replanned task may change, or none). A
// `## Brief` section holds the instructions for the next worker. ok needs an
// action from --allow (default all five), a reason, a non-empty brief for fix
// and replan, and with --verdict a verdict for continue; problem names what is
// missing.
//
// integrate: reads the integration worktree at <dir>/integration, <dir>/pr.md
// and the first line of <dir>/heavy.md (`pass`, `none` or `fail: <why>`).
// merged lists the task ids whose branch is an ancestor of its HEAD. ok needs
// every task merged, a clean tree, a pull request text and heavy checks that
// passed or were not needed. With --tidy yes and ok true it then removes the
// worktree and deletes the branch of every merged task, and prunes stale
// worktree entries; tidied lists those tasks and tidy_problems what it kept.
// It then clears the review and dependency worktrees and the base ref the run
// recorded, leaving the integration branch and any set-aside task worktrees.
// The commit of each branch is written to <dir>/tidied.json before the branch
// is deleted, and a later run checks a missing branch by that commit, so
// running the check again after a tidy gives the same answer. The integrating
// child is shown this command and may well run it before the workflow does.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { abandon, merge, pin, record, where } from "./recipe-git.mjs";

const EXTRACT_CAP_BYTES = 24 * 1024;
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

function quoteTexts(text) {
  const out = [];
  let current = null;
  for (const line of text.split("\n")) {
    const body = line.match(/^\s{0,3}>\s?(.*)$/);
    if (body && body[1].trim()) {
      if (current === null) out.push((current = []));
      current.push(body[1]);
    } else if (!body) current = null;
  }
  return out.map((q) => q.join(" ").replace(/\s+/g, " ").trim());
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
  const range = header.match(/^Range:\s*(\d+)\s*-\s*(\d+)\s*$/m);
  const full = readIfExists(path.resolve(flags.repo ?? ".", source[1]));
  let missing = quoteTexts(text);
  if (full === null) {
    return { ok: false, bytes, quotes, over_cap, file: source[1], missing, reason: "named file missing" };
  }
  let fileLines = full.split("\n");
  if (range) fileLines = fileLines.slice(Math.max(0, Number(range[1]) - 1), Number(range[2]));
  const haystack = fileLines.join(" ").replace(/\s+/g, " ");
  missing = missing.filter((q) => !haystack.includes(q));
  return { ok: quotes > 0 && !over_cap && missing.length === 0, bytes, quotes, over_cap, file: source[1], missing };
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
  const asked = pick(/^Does what was asked:\s*(yes|no|partly)\b/i);
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
  return [dir, PI_WORKTREE_BASE].some((r) => inside(realOr(r), here.worktree));
}

function verdict(file, flags) {
  const out = verdictOf(file);
  if (!flags.run) return out;
  const here = where(process.cwd());
  if (recordable(flags.run, here)) record(flags.run, { kind: "review", id: flags.id, branch: here.branch, worktree: here.worktree });
  return { ...out, branch: here.branch, worktree: here.worktree };
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

function gaps(file) {
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
  const v = verdictOf(file);
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
    t.est = Math.ceil(cost.base + (cost.k_read * bytes) / 4 + cost.growth_p90);
    if (t.est > limit) oversize.push(t.id);
  }

  const cycles = findCycles(tasks);
  const ok = oversize.length === 0 && overlaps.length === 0 && cycles.length === 0 && missing.length === 0;
  return { ok, tasks, oversize, overlaps, missing, cycles };
}

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 1500;
const LIST_CAP = 50;
const REPORT_HEAD = /^(done, concerns|done|blocked|failed)\b:?\s*(.*)$/i;

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

function task(report, flags) {
  if (!flags.check) throw new Usage("task needs --check");
  const cwd = process.cwd();
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

  const check = { command: flags.check, exit: null, tail: "" };
  if (passing && head) {
    const r = spawnSync("sh", ["-c", flags.check], { cwd, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
    check.exit = r.status ?? -1;
    check.tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-TAIL_CHARS);
  }

  let reason = "";
  if (!passing) reason = `report ${rep.status}: ${rep.why}`;
  else if (!head || !branch || branch === "HEAD") reason = "not on a branch of a git worktree";
  else if (!base) reason = "no base commit: pass --repo of the source checkout";
  else if (!fromBase) reason = `branch does not start from the run's base ${base}`;
  else if (commits === 0) reason = "no commits on the branch";
  else if (!clean) reason = "uncommitted changes in the worktree";
  else if (outside.length) reason = `changed files outside owns: ${outside.slice(0, LIST_CAP).join(", ")}`;
  else if (check.exit !== 0) reason = `check failed (exit ${check.exit}): ${check.tail}`;

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
    files: changed.slice(0, LIST_CAP),
    outside: outside.slice(0, LIST_CAP),
    check,
  };
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

  const reasons = [];
  if (!head) reasons.push("no integration worktree");
  else if (flags.branch && branch !== flags.branch) reasons.push(`integration worktree is on ${branch}, not ${flags.branch}`);
  if (unmerged.length) reasons.push(`not merged: ${unmerged.join(", ")}`);
  if (head && !clean) reasons.push("uncommitted changes in the integration worktree");
  if (!pr_text) reasons.push("pr.md missing or empty");
  if (heavy_check !== "pass" && heavy_check !== "none") reasons.push(`heavy checks: ${heavy_check}`);
  const ok = reasons.length === 0;
  const out = { ok, reasons, branch, head, merged, unmerged, clean, heavy_check, pr_text };
  if (flags.tidy === "yes" && ok) {
    Object.assign(out, tidy(worktree, pairs.filter(([id]) => merged.includes(id)), recordFile, tidied));
    out.tidy_problems.push(...abandon(dir, { kinds: ["review", "deps", "base"] }).problems);
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
  const tasks = {};
  for (const m of ledger.made ?? []) {
    if (m.kind !== "task" || !m.id) continue;
    const head = branchTip(repo, m.branch);
    const pattern = new RegExp(`^review-${m.id}-(\\d+)\\.md$`);
    const latest = files
      .map((f) => pattern.exec(f))
      .filter(Boolean)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    const merged = Boolean(head && target) && spawnSync("git", ["merge-base", "--is-ancestor", head, target], { cwd: repo }).status === 0;
    tasks[m.id] = { branch: m.branch, head, review: latest ? verdictOf(path.join(dir, latest[0])).verdict : null, merged };
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

const ACTIONS = ["continue", "retry", "fix", "replan", "decide"];
const DIAGNOSIS_KEY = /^(action|reason|verdict|owns):[ \t]*(.*?)\s*$/i;

function diagnosis(file, flags) {
  const allowed = flags.allow ? String(flags.allow).split(",").map((a) => a.trim()) : ACTIONS;
  const text = readIfExists(file);
  const none = { ok: false, action: null, reason: "", verdict: null, owns: [], brief: false };
  if (text === null) return { ...none, problem: "file missing" };
  const lines = text.split("\n").map((l) => l.replace(/^[\s>*`_-]+/, "").replace(/[*`_]+/g, ""));
  const fields = {};
  let start = lines.findIndex((l) => /^action:/i.test(l));
  for (let i = start; start >= 0 && i < lines.length && !/^#/.test(lines[i]); i++) {
    const m = lines[i].match(DIAGNOSIS_KEY);
    if (m && !(m[1].toLowerCase() in fields)) fields[m[1].toLowerCase()] = m[2];
  }
  const briefAt = text.search(/^##\s+Brief\s*$/im);
  const brief = briefAt >= 0 && text.slice(briefAt).replace(/^##\s+Brief\s*$/im, "").split(/^##\s/m)[0].trim().length > 0;
  const action = (fields.action || "").toLowerCase().split(/\s/)[0] || null;
  const verdictWord = (fields.verdict || "").toLowerCase().match(/^(clean|needs-work)\b/);
  const out = {
    ok: true,
    action,
    reason: fields.reason || "",
    verdict: verdictWord ? verdictWord[1] : null,
    owns: fields.owns ? ownsList(fields.owns) : [],
    brief,
  };
  let problem = null;
  if (!action) problem = "no action line";
  else if (!ACTIONS.includes(action)) problem = `unknown action ${action}`;
  else if (!allowed.includes(action)) problem = `action ${action} is not allowed here (${allowed.join(", ")})`;
  else if (!out.reason) problem = "no reason line";
  else if ((action === "fix" || action === "replan") && !brief) problem = `action ${action} needs a ## Brief section`;
  else if (action === "continue" && flags.verdict && !out.verdict) problem = "action continue needs a verdict line";
  return problem ? { ...out, ok: false, problem } : out;
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const target = positional[0];
  if (!cmd || target === undefined) throw new Usage("usage: recipe-gate urls|paths|extract|size|verdict|angles|gaps|diagnosis|plan|task|pin|merge|abandon|integrate|resume <path> [flags]");
  switch (cmd) {
    case "urls":
      return urls(target);
    case "paths":
      return paths(target);
    case "extract":
      return extract(target, flags);
    case "size":
      return size(target, flags);
    case "verdict":
      return verdict(target, flags);
    case "angles":
      return angles(target);
    case "gaps":
      return gaps(target);
    case "diagnosis":
      return diagnosis(target, flags);
    case "plan":
      return plan(target, flags);
    case "task":
      return task(target, flags);
    case "pin":
      return pin(target, { repo: flags.repo });
    case "merge":
      return merge(target, { dir: flags.dir, branch: flags.branch, onto: flags.onto, tips: flags.tips, check: flags.check, kind: flags.kind, id: flags.id });
    case "abandon":
      return abandon(target, { keep: flags.keep });
    case "integrate":
      return integrate(target, flags);
    case "resume":
      return resume(target, flags);
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
