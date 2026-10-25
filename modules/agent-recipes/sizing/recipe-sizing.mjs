// Proposes sizing.json from the runner's transcripts (<task dir>/runner/transcripts/). Offline: file reads only.
//
//   recipe-sizing <sessions-dir> [--current sizing.json] [--min-samples 20] [--engine-rev REV]
//
// Every `<run-id>_<role>_transcript.jsonl` under the sessions dir is one run.
// A request's context is usage.input (uncached) + usage.cacheRead (cached).
// Per role: base is the median first-request context, peak_p90 the 90th
// percentile of the run's peak, growth_p90 the 90th percentile of peak minus
// base (minus k_read x read tokens for implementer and reviewer), compact_rate
// the share of runs whose context dropped by over 30% from above 40k between
// two requests, cold_per_run the mean number of requests with over 15k
// uncached input. k_read is the least-squares slope through the origin of
// (peak - base) on tokens returned by `read` (chars / 4); it exists only for
// roles that read files they were told about. The old role name `worker` is
// the implementer.
//
// `handoffs` lists, per role with outcome records, how often runs handed off
// (handoff_rate) and what became of the handoffs: the share relayed and the
// share split (relay_rate, split_rate, counted by distinct predecessor run),
// plus the last recorded budget. These come straight from the `outcome` and
// `handoff-outcome` records, so Claude runs without message records count,
// and a role below --min-samples is still listed, with low_samples true.
//
// Guards: a role with fewer than --min-samples runs keeps its entry from
// --current (and is left out when there is none); a role whose current entry
// is measured (samples > 0) moves at most x1.5 either way per field. Defaults
// (samples 0) are replaced outright by the first measurement.

import fs from "node:fs";
import path from "node:path";

const COLD_INPUT = 15000;
const COMPACT_FROM = 40000;
const COMPACT_RATIO = 0.7;
const MAX_CHANGE = 1.5;
const K_READ_ROLES = new Set(["implementer", "reviewer"]);
const ROLE_ALIASES = { worker: "implementer" };
const CLAMPED = ["base", "k_read", "growth_p90", "peak_p90", "compact_rate", "cold_per_run"];

class Usage extends Error {}

function transcripts(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...transcripts(full));
    else if (/^[0-9a-f-]{36}_.+_transcript\.jsonl$/.test(entry.name)) found.push(full);
  }
  return found;
}

function roleOf(file) {
  const name = path.basename(file).match(/^[0-9a-f-]{36}_(.+)_transcript\.jsonl$/)[1].replace(/_\d+$/, "");
  return ROLE_ALIASES[name] ?? name;
}

function readHandoffs(file, into) {
  const role = roleOf(file);
  const entry = () => (into[role] ??= { runs: 0, handed: 0, relayed: new Set(), split: new Set(), budget: null });
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.recordType === "outcome") {
      const e = entry();
      e.runs++;
      if (r.handoff === true) e.handed++;
      if (r.budget != null) e.budget = r.budget;
    } else if (r?.recordType === "handoff-outcome" && (r.as === "relay" || r.as === "split")) {
      (r.as === "relay" ? entry().relayed : entry().split).add(r.runId);
    }
  }
}

function summariseHandoffs(raw, minSamples) {
  const out = {};
  for (const [role, e] of Object.entries(raw)) {
    if (e.runs === 0) continue;
    const share = (n) => (e.handed === 0 ? 0 : round(n / e.handed, 2));
    out[role] = {
      runs: e.runs,
      handoff_rate: round(e.handed / e.runs, 2),
      relay_rate: share(e.relayed.size),
      split_rate: share(e.split.size),
      budget: e.budget,
      low_samples: e.runs < minSamples,
    };
  }
  return out;
}

function readRun(file) {
  const ctx = [];
  let cold = 0;
  let readChars = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.recordType !== "message") continue;
    const role = r.message?.role;
    if (role === "assistant") {
      const input = r.message.usage?.input ?? 0;
      ctx.push(input + (r.message.usage?.cacheRead ?? 0));
      if (input > COLD_INPUT) cold++;
    } else if (role === "toolResult" && r.toolName === "read") {
      readChars += (r.text ?? "").length;
    }
  }
  if (ctx.length === 0) return null;
  const compacted = ctx.slice(1).some((b, i) => ctx[i] > COMPACT_FROM && b < COMPACT_RATIO * ctx[i]);
  return { base: ctx[0], peak: Math.max(...ctx), cold, compacted, readTokens: readChars / 4 };
}

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const median = (values) => percentile(values, 0.5);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const round = (n, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

function measure(role, runs) {
  const out = {
    samples: runs.length,
    base: round(median(runs.map((r) => r.base))),
    peak_p90: round(percentile(runs.map((r) => r.peak), 0.9)),
    compact_rate: round(runs.filter((r) => r.compacted).length / runs.length, 2),
    cold_per_run: round(mean(runs.map((r) => r.cold)), 2),
  };
  const growth = runs.map((r) => r.peak - r.base);
  if (!K_READ_ROLES.has(role)) {
    out.growth_p90 = round(percentile(growth, 0.9));
    return out;
  }
  const reads = runs.filter((r) => r.readTokens > 0);
  if (reads.length === 0) return out;
  const k = reads.reduce((s, r) => s + r.readTokens * (r.peak - r.base), 0) / reads.reduce((s, r) => s + r.readTokens ** 2, 0);
  out.k_read = round(k, 2);
  out.growth_p90 = round(percentile(runs.map((r) => Math.max(0, r.peak - r.base - out.k_read * r.readTokens)), 0.9));
  return out;
}

function clamp(measured, current) {
  if (!current || !(current.samples > 0)) return measured;
  const out = { ...measured };
  for (const field of CLAMPED) {
    const was = current[field];
    if (out[field] === undefined || !(was > 0)) continue;
    out[field] = Math.min(was * MAX_CHANGE, Math.max(was / MAX_CHANGE, out[field]));
    out[field] = round(out[field], field === "compact_rate" || field === "cold_per_run" || field === "k_read" ? 2 : 0);
  }
  return out;
}

function propose(sessionsDir, currentFile, minSamples, engineRev) {
  const current = currentFile ? JSON.parse(fs.readFileSync(currentFile, "utf8")) : { engine_rev: null, roles: {} };
  const byRole = {};
  const rawHandoffs = {};
  for (const file of transcripts(sessionsDir)) {
    const run = readRun(file);
    if (run) (byRole[roleOf(file)] ??= []).push(run);
    readHandoffs(file, rawHandoffs);
  }
  const roles = { ...current.roles };
  for (const [role, runs] of Object.entries(byRole)) {
    if (runs.length < minSamples) {
      process.stderr.write(`recipe-sizing: ${role}: ${runs.length} runs, below ${minSamples}; ${current.roles[role] ? "kept" : "left out"}\n`);
      continue;
    }
    const measured = measure(role, runs);
    roles[role] = { ...clamp({ ...current.roles[role], ...measured }, current.roles[role]) };
  }
  return { engine_rev: engineRev ?? current.engine_rev ?? null, roles, handoffs: summariseHandoffs(rawHandoffs, minSamples) };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (argv[i + 1] === undefined) throw new Usage(`${argv[i]} needs a value`);
      flags[argv[i].slice(2)] = argv[++i];
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

try {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length !== 1) throw new Usage("usage: recipe-sizing <sessions-dir> [--current file] [--min-samples N] [--engine-rev REV]");
  const minSamples = flags["min-samples"] === undefined ? 20 : Number(flags["min-samples"]);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Usage("--min-samples must be a positive integer");
  process.stdout.write(JSON.stringify(propose(positional[0], flags.current, minSamples, flags["engine-rev"]), null, 2) + "\n");
} catch (err) {
  process.stderr.write(`recipe-sizing: ${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
