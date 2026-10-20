// Checks between the steps of the research recipe. Each subcommand reads
// files, prints one JSON object on stdout and exits 0 on a decision; only
// usage errors (2) and unreadable input where a decision is impossible (1)
// exit nonzero.
//
//   urls <file>                    source list -> {ok, urls:[{url, angle, why, kind}]}
//   extract <file> [--cap BYTES]   {ok, bytes, quotes, over_cap}; cap defaults to 24 KB
//   size <dir> [--window N]        {bytes, est_tokens, split}; N defaults to 221184
//   verdict <review.md>            {asked, sound, clean, verdict}; read from the
//                                  first verdict line and the few lines after
//                                  it, up to the next heading
//   angles <file>                  angle list -> {ok, angles:[{id, question}]}
//   gaps <review.md>               {ok, angles:[{id, question}], asked, sound, clean, verdict}
//   diagnosis <file> [--allow a,b] [--verdict yes]
//                                  {ok, action, reason, verdict, owns:[], brief, problem}
//
// Source list format: a `## <angle id>` heading per angle, then one bullet per
// source, `- <url> | primary|secondary | <one-line why>`. Anything else is
// ignored. A bullet that is not an http(s) URL is dropped.
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
// diagnosis: reads the file a diagnose child writes when a step's output was
// not accepted. From its first `action:` line up to the next heading it takes
// `action:` (continue, retry, fix, replan or decide), `reason:` (one line),
// `verdict:` (clean or needs-work, for a review that could not be read) and
// `owns:` (extra repository paths a replanned task may change, or none). A
// `## Brief` section holds the instructions for the next worker. ok needs an
// action from --allow (default all five), a reason, a non-empty brief for fix
// and replan, and with --verdict a verdict for continue; problem names what is
// missing.

import fs from "node:fs";
import path from "node:path";

const EXTRACT_CAP_BYTES = 24 * 1024;
const DEFAULT_WINDOW = 221184;
const SYNTH_TOKENS = 70000;

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

function extract(file, flags) {
  const cap = intFlag(flags, "cap", EXTRACT_CAP_BYTES);
  let bytes;
  try {
    bytes = fs.statSync(file).size;
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, bytes: 0, quotes: 0, over_cap: false, reason: "file missing" };
    throw err;
  }
  const quotes = countQuotes(fs.readFileSync(file, "utf8"));
  const over_cap = bytes > cap;
  return { ok: quotes > 0 && !over_cap, bytes, quotes, over_cap };
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

function verdict(file) {
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
  const v = verdict(file);
  return { ok: v.verdict !== "invalid", angles: angleBullets(section.join("\n")), ...v };
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
  if (!cmd || target === undefined) throw new Usage("usage: recipe-gate urls|extract|size|verdict|angles|gaps|diagnosis <path> [flags]");
  switch (cmd) {
    case "urls":
      return urls(target);
    case "extract":
      return extract(target, flags);
    case "size":
      return size(target, flags);
    case "verdict":
      return verdict(target);
    case "angles":
      return angles(target);
    case "gaps":
      return gaps(target);
    case "diagnosis":
      return diagnosis(target, flags);
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
