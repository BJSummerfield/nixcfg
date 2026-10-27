// Proposes sizing.json from the runner's records (<task dir>/runner). Offline: file reads only.
//
//   recipe-sizing <sessions-dir>... [--current sizing.json] [--min-samples 20] [--engine-rev REV]
//
// The positional directories are pooled: every
// `<run-id>_<role>_transcript.jsonl` found under any of them is one run, and
// symlinks to directories and files are followed, each real file counted once.
// A run the runner ended for repeating the same turn has `loop` in its settle
// result (children.jsonl); its token counts reflect the loop, not the task,
// so its transcript is left out of every estimate. `looped` counts the
// children left out, per role. A child the graph ran for something other than
// a task (settled under `integrate` or `resolve-*`) is left out the same way
// and counted in `excluded`, per role.
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
// For the implementer, k_read and growth_p90 are instead fitted the way the
// plan gate spends them: the gate sizes a task from the declared bytes of its
// owns and reads files, so each task of the intake settle's
// structuredOutput.tasks pairs its declared bytes (its bytes when recorded,
// else recovered from its est and the sizing the gate used: the intake
// output's top-level sizing, else the task's own) with the context
// at the first write of the first attempt (usage.firstContext of the
// impl-<id> settle). With at least --min-samples pairs, k_read is the
// least-squares slope through the origin of (firstContext - base) on
// declared bytes / 4 and growth_p90 the 90th percentile of the leftover;
// `plan_fit` reports the pairs, the committed values (recomputed when the
// x1.5 bound changes k_read) and how often the new estimate
// would cover the firstContext (covered, coverage).
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
const DEFAULT_SIZING = { base: 7000, k_read: 1, growth_p90: 10000 };
const TRANS_NAME = /^[0-9a-f-]{36}_.+_transcript\.jsonl$/;

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
          visitFile(file);
        }
      }
    }
  };
  for (const dir of dirs) {
    const real = fs.realpathSync(dir);
    if (!seen.has(real)) visit(dir, real);
  }
}

function findFiles(dirs) {
  const transcripts = [];
  const children = [];
  walk(dirs, (file) => {
    const name = path.basename(file);
    if (TRANS_NAME.test(name)) transcripts.push(file);
    else if (name === "children.jsonl") children.push(file);
  });
  return { transcripts, children };
}

function roleOf(file) {
  const name = path.basename(file).match(/^[0-9a-f-]{36}_(.+)_transcript\.jsonl$/)[1].replace(/_\d+$/, "");
  return ROLE_ALIASES[name] ?? name;
}

function settleRecords(files) {
  const records = [];
  for (const file of files)
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r?.type === "settle") records.push(r);
    }
  return records;
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
  let runId = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.recordType === "outcome" && runId === null && r.runId) runId = r.runId;
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
  if (ctx.length === 0) return { runId, run: null };
  const compacted = ctx.slice(1).some((b, i) => ctx[i] > COMPACT_FROM && b < COMPACT_RATIO * ctx[i]);
  return { runId, run: { base: ctx[0], peak: Math.max(...ctx), cold, compacted, readTokens: readChars / 4 } };
}

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const median = (values) => percentile(values, 0.5);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const round = (n, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
// Rounding the float noise away first keeps 1.1 and 0.07 from creeping up on every re-run.
const roundUp2 = (x) => Math.ceil(Math.round(x * 1e6) / 1e4) / 100;

function planPairs(files) {
  const pairs = [];
  for (const file of files) {
    const settles = settleRecords([file]);
    const byKey = new Map();
    for (const r of settles) if (r.key !== undefined && !byKey.has(r.key)) byKey.set(r.key, r);
    for (const r of settles) {
      if (r.key !== "intake" || !Array.isArray(r.result?.structuredOutput?.tasks)) continue;
      for (const t of r.result.structuredOutput.tasks) {
        const first = byKey.get(`impl-${t.id}`)?.result?.usage?.firstContext;
        const sizing = { ...DEFAULT_SIZING, ...(r.result.structuredOutput.sizing ?? t.sizing ?? {}) };
        const bytes = typeof t.bytes === "number" ? t.bytes : (t.est - sizing.base - sizing.growth_p90) * 4 / sizing.k_read;
        if (!Number.isFinite(bytes) || !Number.isFinite(first)) continue;
        pairs.push({ tokens: bytes / 4, firstContext: first });
      }
    }
  }
  return pairs;
}

function fitPlan(pairs, base) {
  let sxy = 0;
  let sx2 = 0;
  for (const p of pairs) {
    sxy += p.tokens * (p.firstContext - base);
    sx2 += p.tokens ** 2;
  }
  const k = roundUp2(sx2 === 0 ? 0 : sxy / sx2);
  const growth = residualP90(pairs, base, k);
  return { pairs: pairs.length, k_read: k, growth_p90: growth, ...coverage(pairs, base, k, growth) };
}

function residualP90(pairs, base, k) {
  return Math.ceil(percentile(pairs.map((p) => Math.max(0, p.firstContext - base - k * p.tokens)), 0.9));
}

function coverage(pairs, base, k, growth) {
  const covered = pairs.filter((p) => base + k * p.tokens + growth >= p.firstContext).length;
  return { covered, coverage: round(covered / pairs.length, 2) };
}

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

function clampField(field, value, was, role) {
  const bounded = Math.min(was * MAX_CHANGE, Math.max(was / MAX_CHANGE, value));
  if (field === "k_read") return role === "implementer" ? roundUp2(bounded) : round(bounded, 2);
  return round(bounded, field === "compact_rate" || field === "cold_per_run" ? 2 : 0);
}

function clamp(measured, current, role) {
  if (!current || !(current.samples > 0)) return measured;
  const out = { ...measured };
  for (const field of CLAMPED) {
    const was = current[field];
    if (out[field] === undefined || !(was > 0)) continue;
    out[field] = clampField(field, out[field], was, role);
  }
  return out;
}

function propose(sessionsDirs, currentFile, minSamples, engineRev) {
  const current = currentFile ? JSON.parse(fs.readFileSync(currentFile, "utf8")) : { engine_rev: null, roles: {} };
  const { transcripts, children } = findFiles(sessionsDirs);
  const byRole = {};
  const rawHandoffs = {};
  const loopedOut = {};
  const excludedOut = {};
  const keys = new Map();
  const looped = new Set();
  for (const r of settleRecords(children)) {
    if (!r.runId) continue;
    if (r.result?.loop) looped.add(r.runId);
    keys.set(r.runId, r.key);
  }
  for (const file of transcripts) {
    const { runId, run } = readRun(file);
    const role = roleOf(file);
    if (runId !== null && looped.has(runId)) {
      loopedOut[role] = (loopedOut[role] ?? 0) + 1;
      continue;
    }
    const key = runId === null ? undefined : keys.get(runId);
    if (key === "integrate" || (typeof key === "string" && key.startsWith("resolve-"))) {
      excludedOut[role] = (excludedOut[role] ?? 0) + 1;
      continue;
    }
    if (run) (byRole[role] ??= []).push(run);
    readHandoffs(file, rawHandoffs);
  }
  const pairs = planPairs(children);
  const implementerRuns = byRole.implementer;
  const fitBase = implementerRuns?.length > 0 ? round(median(implementerRuns.map((r) => r.base))) : null;
  const planFit = fitBase !== null && pairs.length >= minSamples ? fitPlan(pairs, fitBase) : null;
  const roles = { ...current.roles };
  for (const [role, runs] of Object.entries(byRole)) {
    if (runs.length < minSamples) {
      process.stderr.write(`recipe-sizing: ${role}: ${runs.length} runs, below ${minSamples}; ${current.roles[role] ? "kept" : "left out"}\n`);
      continue;
    }
    const measured = measure(role, runs);
    if (role === "implementer" && planFit) {
      measured.k_read = planFit.k_read;
      measured.growth_p90 = planFit.growth_p90;
    }
    roles[role] = { ...clamp({ ...current.roles[role], ...measured }, current.roles[role], role) };
    if (role === "implementer" && planFit) {
      const was = current.roles[role];
      if (roles[role].k_read !== planFit.k_read) {
        let growth = residualP90(pairs, fitBase, roles[role].k_read);
        if (was?.samples > 0 && was.growth_p90 > 0) growth = clampField("growth_p90", growth, was.growth_p90, role);
        roles[role].growth_p90 = growth;
      }
      Object.assign(planFit, { k_read: roles[role].k_read, growth_p90: roles[role].growth_p90 });
      Object.assign(planFit, coverage(pairs, fitBase, planFit.k_read, planFit.growth_p90));
    }
  }
  return {
    engine_rev: engineRev ?? current.engine_rev ?? null,
    roles,
    handoffs: summariseHandoffs(rawHandoffs, minSamples),
    looped: loopedOut,
    excluded: excludedOut,
    plan_fit: planFit ?? { pairs: pairs.length },
  };
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
  if (positional.length < 1) throw new Usage("usage: recipe-sizing <sessions-dir>... [--current file] [--min-samples N] [--engine-rev REV]");
  const minSamples = flags["min-samples"] === undefined ? 20 : Number(flags["min-samples"]);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Usage("--min-samples must be a positive integer");
  process.stdout.write(JSON.stringify(propose(positional, flags.current, minSamples, flags["engine-rev"]), null, 2) + "\n");
} catch (err) {
  process.stderr.write(`recipe-sizing: ${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
