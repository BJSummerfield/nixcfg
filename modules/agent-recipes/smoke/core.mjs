import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FLAGS = {
  "--full": (o) => (o.full = true),
  "--skip-claude": (o) => (o.skipClaude = true),
  "--keep": (o) => (o.keep = true),
  "--force": (o) => (o.force = true),
  "--only": (o, v, flag) => {
    o.only = v.split(",").map((s) => s.trim()).filter(Boolean);
    if (o.only.length === 0) throw new Error(`flag ${flag} needs at least one test name`);
  },
  "--out": (o, v) => (o.out = v),
};

export function parseArgs(argv) {
  const opts = { full: false, only: null, skipClaude: false, keep: false, force: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const apply = FLAGS[flag];
    if (!apply) throw new Error(`unknown flag ${flag}`);
    if (flag === "--only" || flag === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`flag ${flag} needs a value`);
      apply(opts, value, flag);
    } else {
      apply(opts);
    }
  }
  return opts;
}

export function selectTests(names, opts = {}) {
  if (opts.only) {
    const known = new Set(names);
    for (const n of opts.only) {
      if (!known.has(n)) throw new Error(`unknown test ${n}`);
    }
  }
  return names.filter((n) => (!opts.only || opts.only.includes(n)) && (!opts.skipClaude || !n.endsWith("-claude")));
}

export function metricsUrl(modelsJson, provider) {
  const baseUrl = modelsJson?.providers?.[provider]?.baseUrl;
  if (!baseUrl) throw new Error(`provider ${provider} has no baseUrl in models.json`);
  return new URL(baseUrl).origin + "/ops/metrics";
}

function gaugeValue(text, name) {
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = line.match(new RegExp(`^${name}(\\{[^}]*\\})?\\s+(-?[0-9]+(?:\\.[0-9]+)?)\\s*(?:[#].*)?$`));
    if (m) return Number(m[2]);
  }
  return 0;
}

export function engineLoad(metricsText) {
  return {
    running: gaugeValue(metricsText, "ninfer_running"),
    waiting: gaugeValue(metricsText, "ninfer_waiting"),
  };
}

export function isBusy(load) {
  return load.running > 0 || load.waiting > 0;
}

export function makeWorkdir(parent) {
  const dir = path.join(parent, `recipe-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeWorkdir(dir, keep) {
  if (keep) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function git(cwd, ...args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

// fixtures installed from the nix store are read-only, and the copies keep their modes
function makeWritable(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const mode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, mode | 0o200);
    if (entry.isDirectory()) makeWritable(target);
  }
}

export function setupRepo(fixturesDir, dest) {
  fs.cpSync(path.join(fixturesDir, "tinycalc"), dest, { recursive: true });
  makeWritable(dest);
  git(dest, "init", "-q", "-b", "main");
  git(dest, "config", "user.name", "recipe-smoke");
  git(dest, "config", "user.email", "smoke@recipe.invalid");
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "-m", "fixture: tinycalc");
  return git(dest, "rev-parse", "HEAD");
}

export function setupPlan(fixturesDir, dest) {
  fs.cpSync(path.join(fixturesDir, "tinycalc-plan"), dest, { recursive: true });
  makeWritable(dest);
  return dest;
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const prev = target[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      target[key] = mergeDeep(prev !== null && typeof prev === "object" && !Array.isArray(prev) ? prev : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function withRoleOverrides(config, overrides = {}) {
  const copy = JSON.parse(JSON.stringify(config));
  const roles = (copy.roles ??= {});
  for (const [name, partial] of Object.entries(overrides)) {
    roles[name] = mergeDeep(roles[name] ?? {}, partial);
  }
  return copy;
}

const DETAIL_LIMIT = 60;

function wall(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function verdict(r) {
  if (r.pass === true) return "pass";
  if (r.pass === false) return "FAIL";
  return "skip";
}

function detail(s) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > DETAIL_LIMIT ? `${one.slice(0, DETAIL_LIMIT - 1)}…` : one;
}

function num(v) {
  return Number(v) || 0;
}

export function formatTable(results) {
  const rows = results.map((r) => [
    r.name,
    verdict(r),
    wall(r.ms),
    String(num(r.children)),
    String(num(r.usage?.prompt)),
    String(num(r.usage?.cached)),
    String(num(r.usage?.output)),
    detail(r.detail),
  ]);
  const totals = [
    "totals",
    `${results.filter((r) => r.pass === true).length}p ${results.filter((r) => r.pass === false).length}f ${results.filter((r) => r.pass !== true && r.pass !== false).length}s`,
    wall(results.reduce((a, r) => a + num(r.ms), 0)),
    String(results.reduce((a, r) => a + num(r.children), 0)),
    String(results.reduce((a, r) => a + num(r.usage?.prompt), 0)),
    String(results.reduce((a, r) => a + num(r.usage?.cached), 0)),
    String(results.reduce((a, r) => a + num(r.usage?.output), 0)),
    "",
  ];
  const headers = ["test", "result", "time", "children", "prompt", "cached", "output", "detail"];
  const widths = headers.map((h, i) => Math.max(h.length, ...[...rows, totals].map((r) => r[i].length)));
  const render = (row) => row.map((cell, i) => (i >= 2 && i <= 6 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ");
  return [render(headers), ...rows.map(render), render(totals)].join("\n");
}

export function resultRecord(results, meta) {
  return { startedAt: meta.startedAt, finishedAt: meta.finishedAt, host: meta.host, full: meta.full, results };
}
