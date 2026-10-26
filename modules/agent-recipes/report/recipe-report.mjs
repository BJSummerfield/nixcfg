// Turns recorded recipe runs into numbers (<run dir>/runner). Offline: file reads only.
//
//   recipe-report <run-dir>... [--json]
//
// The positional directories are walked recursively, following symlinks,
// each real directory once; a run is a directory holding both
// runner/status.json and runner/children.jsonl, counted once however many
// paths reach it. children.jsonl is one JSON object per line; lines that do
// not parse are skipped. receipt.json next to runner/ is counted when
// present: the merged, set_aside, decide and open arrays.
// Wall minutes are lastUpdate minus startedAt. cached_share_of_prompt is
// cached over prompt, which already includes the cached tokens. The role of
// a settle comes from the start record of its runId, pooled over all runs;
// a handoff is a settle whose handoff is set, followed by the relay or split
// handoff records whose runId is that child's, counted by distinct child.
// Medians and p90 are nearest rank. The task of a review settle is the key
// with its trailing -<n> round removed; its first round is the -1 one.

import fs from "node:fs";
import path from "node:path";

class Usage extends Error {}

function walk(dirs, visitFile) {
  const seen = new Set();
  const visit = (dir, real) => {
    seen.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      let st = entry;
      if (entry.isSymbolicLink()) {
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
      }
      if (st.isDirectory()) {
        const sub = fs.realpathSync(full);
        if (!seen.has(sub)) visit(full, sub);
      } else if (st.isFile()) {
        const file = fs.realpathSync(full);
        if (!seen.has(file)) {
          seen.add(file);
          visitFile(full);
        }
      }
    }
  };
  for (const dir of dirs) {
    const real = fs.realpathSync(dir);
    if (!seen.has(real)) visit(dir, real);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r && typeof r === "object") out.push(r);
  }
  return out;
}

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const round = (n, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
// Nearest rank: the ceil(q x n)-th smallest value.
const percentile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(1, Math.ceil(q * sorted.length)) - 1)];
};
const sortedKeys = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

function findRuns(dirs) {
  const runs = new Set();
  // The runner subdirectory may be a symlink to a differently named directory,
  // so match on the name it has as walked but record the real path.
  walk(dirs, (file) => {
    const runner = path.dirname(file);
    if (path.basename(file) !== "children.jsonl" || path.basename(runner) !== "runner") return;
    if (fs.existsSync(path.join(runner, "status.json"))) runs.add(fs.realpathSync(path.dirname(runner)));
  });
  return [...runs].sort();
}

function readRun(runDir) {
  const runner = path.join(runDir, "runner");
  const status = readJson(path.join(runner, "status.json")) ?? {};
  const records = readJsonl(path.join(runner, "children.jsonl"));
  const settles = records.filter((r) => r.type === "settle");
  const starts = new Map();
  for (const r of records) if (r.type === "start" && typeof r.runId === "string" && !starts.has(r.runId)) starts.set(r.runId, r.role);
  const handoffs = records.filter((r) => r.type === "handoff" && (r.as === "relay" || r.as === "split") && typeof r.runId === "string");
  let prompt = 0;
  let cached = 0;
  let output = 0;
  for (const s of settles) {
    const u = s.result?.usage;
    if (u && typeof u === "object") {
      prompt += num(u.prompt);
      cached += num(u.cached);
      output += num(u.output);
    }
  }
  const t0 = Date.parse(status.startedAt);
  const t1 = Date.parse(status.lastUpdate);
  const receipt = readJson(path.join(runDir, "receipt.json"));
  const receiptCounts =
    receipt && typeof receipt === "object"
      ? Object.fromEntries(["merged", "set_aside", "decide", "open"].filter((k) => Array.isArray(receipt[k])).map((k) => [k, receipt[k].length]))
      : null;
  const entry = {
    path: runDir,
    recipe: status.recipe ?? null,
    harness: status.harness ?? null,
    state: status.state ?? null,
    minutes: Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? round((t1 - t0) / 60000, 1) : null,
    children: settles.length,
    prompt,
    cached,
    output,
    cached_share_of_prompt: prompt > 0 ? round(cached / prompt, 2) : 0,
    receipt: receiptCounts,
  };
  return { entry, settles, starts, handoffs };
}

function roleStats(settles, starts, handoffs) {
  const byRole = {};
  const slot = (role) => (byRole[role] ??= { children: 0, statuses: {}, handoffs: 0, relayed: new Set(), split: new Set(), loops: 0, compactions: 0, peaks: [] });
  const handed = new Set();
  for (const s of settles) {
    const e = slot(typeof s.runId === "string" ? starts.get(s.runId) ?? "unknown" : "unknown");
    e.children++;
    if (typeof s.result?.status === "string") e.statuses[s.result.status] = (e.statuses[s.result.status] ?? 0) + 1;
    if (s.result?.handoff) {
      e.handoffs++;
      handed.add(s.runId);
    }
    if (s.result?.loop) e.loops++;
    e.compactions += num(s.result?.usage?.compactions);
    const peak = s.result?.usage?.peakContext;
    if (typeof peak === "number" && Number.isFinite(peak)) e.peaks.push(peak);
  }
  for (const h of handoffs) {
    if (!handed.has(h.runId)) continue;
    const e = slot(starts.get(h.runId) ?? "unknown");
    (h.as === "relay" ? e.relayed : e.split).add(h.runId);
  }
  return Object.fromEntries(
    Object.entries(byRole)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([role, e]) => [
        role,
        {
          children: e.children,
          statuses: sortedKeys(e.statuses),
          handoffs: e.handoffs,
          relayed: e.relayed.size,
          split: e.split.size,
          loops: e.loops,
          compactions: e.compactions,
          peak_median: percentile(e.peaks, 0.5),
          peak_p90: percentile(e.peaks, 0.9),
        },
      ]),
  );
}

const REVIEW_KEY = /^review-(.+)-(\d+)$/;

function reviewStats(settles) {
  const byVerdict = {};
  const tasks = new Map();
  for (const s of settles) {
    if (typeof s.key !== "string" || !s.key.startsWith("review-")) continue;
    const verdict = s.result?.structuredOutput?.verdict;
    if (typeof verdict === "string") byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    const m = s.key.match(REVIEW_KEY);
    if (!m) continue;
    const t = tasks.get(m[1]) ?? { rounds: new Set(), first: null };
    tasks.set(m[1], t);
    t.rounds.add(Number(m[2]));
    if (Number(m[2]) === 1) t.first = verdict;
  }
  const taskOut = Object.fromEntries(
    [...tasks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, t]) => [name, { first_clean: t.first === "clean", rounds: t.rounds.size }]),
  );
  const firstClean = Object.values(taskOut).filter((t) => t.first_clean).length;
  const total = Object.keys(taskOut).length;
  return { by_verdict: sortedKeys(byVerdict), tasks: taskOut, first_clean: firstClean, first_clean_share: total > 0 ? round(firstClean / total, 2) : null };
}

function diagnosisStats(settles) {
  let diagnoses = 0;
  let retries = 0;
  for (const s of settles) {
    if (typeof s.key !== "string") continue;
    if (s.key.startsWith("diagnosis") || s.key.startsWith("diagnose")) diagnoses++;
    if (s.key.endsWith(".retry") || s.key.endsWith("-retry")) retries++;
  }
  return { diagnoses, retries };
}

function report(dirs) {
  const loaded = findRuns(dirs).map(readRun);
  const settles = loaded.flatMap((l) => l.settles);
  const starts = new Map();
  for (const l of loaded) for (const [runId, role] of l.starts) if (!starts.has(runId)) starts.set(runId, role);
  return {
    runs: loaded.map((l) => l.entry),
    roles: roleStats(settles, starts, loaded.flatMap((l) => l.handoffs)),
    reviews: reviewStats(settles),
    diagnoses: diagnosisStats(settles),
  };
}

const str = (v) => (v === null || v === undefined ? "-" : String(v));
const kv = (o) => Object.entries(sortedKeys(o)).map(([k, v]) => `${k}=${v}`).join(",");

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c ?? "") : String(c ?? "").padEnd(widths[i]))).join("  ")).join("\n");
}

function render(r) {
  const lines = ["runs:"];
  if (r.runs.length > 0)
    lines.push(
      table([
        ["path", "recipe", "harness", "state", "minutes", "children", "prompt", "cached", "output", "cached_share_of_prompt", "receipt"],
        ...r.runs.map((run) => [
          run.path,
          str(run.recipe),
          str(run.harness),
          str(run.state),
          str(run.minutes),
          run.children,
          run.prompt,
          run.cached,
          run.output,
          str(run.cached_share_of_prompt),
          run.receipt ? kv(run.receipt) : "-",
        ]),
      ]),
    );
  lines.push("", "roles:");
  const roleRows = Object.entries(r.roles).map(([role, e]) => [
    role,
    e.children,
    kv(e.statuses),
    e.handoffs,
    e.relayed,
    e.split,
    e.loops,
    e.compactions,
    str(e.peak_median),
    str(e.peak_p90),
  ]);
  if (roleRows.length > 0) lines.push(table([["role", "children", "statuses", "handoffs", "relayed", "split", "loops", "compactions", "peak_median", "peak_p90"], ...roleRows]));
  lines.push("", "reviews:");
  if (Object.keys(r.reviews.by_verdict).length > 0) lines.push(`by_verdict: ${kv(r.reviews.by_verdict)}`);
  for (const [task, t] of Object.entries(r.reviews.tasks)) lines.push(`${task}: first_clean=${t.first_clean ? "yes" : "no"},rounds=${t.rounds}`);
  lines.push(`first_clean_share: ${str(r.reviews.first_clean_share)}`);
  lines.push(`diagnoses: ${r.diagnoses.diagnoses}, retries: ${r.diagnoses.retries}`);
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg.startsWith("-")) throw new Usage(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

try {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 1) throw new Usage("usage: recipe-report <run-dir>... [--json]");
  for (const dir of positional) {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Usage(`no such directory: ${dir}`);
    }
    if (!st.isDirectory()) throw new Usage(`not a directory: ${dir}`);
  }
  const r = report(positional);
  process.stdout.write(flags.json ? JSON.stringify(r, null, 2) + "\n" : render(r));
} catch (err) {
  process.stderr.write(`recipe-report: ${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
