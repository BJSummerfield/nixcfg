import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../runner/config.mjs";

const here = fileURLToPath(import.meta.url);
const RUNNER_CLI = fileURLToPath(new URL("../runner/cli.mjs", import.meta.url));
const DISPATCH_TIMEOUT_MS = 20 * 60 * 1000;
const ERROR_TAIL = 500;

const USAGE = "usage: recipe-bench <cases.json> --config <name>=<file>[@<harness>] [--config ...] [--repeat N] [--out DIR] [--force]";

class UsageError extends Error {}

// Names double as directory names under --out, so keep them filesystem-safe.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function parseConfigSpec(spec) {
  const eq = spec.indexOf("=");
  const name = eq > 0 ? spec.slice(0, eq) : "";
  const rest = eq < 0 ? spec : spec.slice(eq + 1);
  if (!NAME.test(name)) throw new UsageError(`--config needs a <name>=<file> form: ${spec}`);
  const at = rest.lastIndexOf("@");
  const file = at < 0 ? rest : rest.slice(0, at);
  const harness = at < 0 ? "pi" : rest.slice(at + 1);
  if (!file) throw new UsageError(`--config names no config file: ${spec}`);
  if (!NAME.test(harness)) throw new UsageError(`--config names a bad harness: ${spec}`);
  return { name, file: path.resolve(file), harness };
}

function parseArgs(argv) {
  const opts = { cases: null, configs: [], repeat: 1, out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "--out" || arg === "--repeat") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`flag ${arg} needs a value`);
      if (arg === "--config") opts.configs.push(parseConfigSpec(value));
      else if (arg === "--out") opts.out = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`--repeat must be a positive integer: ${value}`);
        opts.repeat = n;
      }
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown flag ${arg}`);
    } else if (opts.cases !== null) {
      throw new UsageError("expected exactly one cases file");
    } else {
      opts.cases = arg;
    }
  }
  if (opts.cases === null) throw new UsageError(USAGE);
  if (opts.configs.length === 0) throw new UsageError("--config <name>=<file>[@<harness>] is required");
  const names = new Set();
  for (const config of opts.configs) {
    if (names.has(config.name)) throw new UsageError(`duplicate --config name ${config.name}`);
    names.add(config.name);
    if (!fs.existsSync(config.file)) throw new UsageError(`the runner config ${config.file} does not exist`);
  }
  return opts;
}

function loadCases(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read the cases file ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`the cases file ${file} is not JSON: ${error.message}`);
  }
  if (typeof data?.repo !== "string" || !path.isAbsolute(data.repo)) {
    throw new UsageError("the cases file needs an absolute repo path");
  }
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    throw new UsageError("the cases file needs a non-empty cases list");
  }
  const names = new Set();
  const cases = data.cases.map((raw) => {
    const label = `case ${typeof raw?.name === "string" && raw.name !== "" ? raw.name : "?"}`;
    for (const key of ["name", "base", "head", "task", "check"]) {
      if (typeof raw?.[key] !== "string" || raw[key] === "") throw new UsageError(`${label} needs a non-empty ${key}`);
    }
    if (!NAME.test(raw.name)) throw new UsageError(`${label} name is not a safe directory name: ${raw.name}`);
    if (names.has(raw.name)) throw new UsageError(`duplicate case name ${raw.name}`);
    names.add(raw.name);
    if (raw.expect !== "needs-work" && raw.expect !== "clean") {
      throw new UsageError(`${label} expect must be needs-work or clean`);
    }
    if (!Array.isArray(raw.defects)) throw new UsageError(`${label} needs a defects list`);
    const ids = new Set();
    const defects = raw.defects.map((d) => {
      if (typeof d?.id !== "string" || d.id === "") throw new UsageError(`${label} defects need a non-empty id`);
      if (ids.has(d.id)) throw new UsageError(`${label} has a duplicate defect id ${d.id}`);
      ids.add(d.id);
      if (!Array.isArray(d.match) || d.match.length === 0 || !d.match.every((m) => typeof m === "string")) {
        throw new UsageError(`${label} defect ${d.id} needs a non-empty match list of regexes`);
      }
      const match = d.match.map((m) => {
        try {
          return new RegExp(m, "i");
        } catch {
          throw new UsageError(`${label} defect ${d.id} match is not a regex: ${m}`);
        }
      });
      return { id: d.id, match };
    });
    return { name: raw.name, base: raw.base, head: raw.head, task: raw.task, check: raw.check, expect: raw.expect, defects };
  });
  return { repo: data.repo, cases };
}

function metricsUrl(modelsJson, provider) {
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

function engineLoad(metricsText) {
  return { running: gaugeValue(metricsText, "ninfer_running"), waiting: gaugeValue(metricsText, "ninfer_waiting") };
}

async function engineGuard(deps) {
  const config = loadConfig();
  const [provider] = String(config.model ?? "").split("/");
  if (!provider) throw new Error("the runner config model is not a <provider>/<model>");
  let modelsJson;
  try {
    modelsJson = JSON.parse(fs.readFileSync(deps.modelsFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${deps.modelsFile}: ${error.message}`);
  }
  const url = metricsUrl(modelsJson, provider);
  let text;
  try {
    const response = await deps.fetch(url);
    if (!response.ok) throw new Error(`metrics returned HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    return { code: 3, message: `cannot check the engine metrics at ${url}: ${error.message}; use --force to run anyway` };
  }
  const load = engineLoad(text);
  if (load.running > 0 || load.waiting > 0) {
    return { code: 3, message: `the engine is busy: ${load.running} running, ${load.waiting} waiting; use --force to run anyway` };
  }
  return null;
}

function makeRunner(deps) {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = deps.spawn(process.execPath, [RUNNER_CLI, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

function renderBrief(c, reviewFile) {
  return [
    "Review variant: Diff on a branch",
    "",
    "Task:",
    c.task,
    "",
    `Diff command: git diff ${c.base}..${c.head}`,
    `Check: ${c.check}`,
    `Write the review to: ${reviewFile}`,
    "",
  ].join("\n");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const HEADING = /^#{1,6}\s/;

// Section text is split on markdown headings so a defect named only under
// "## Small findings" is not scored the same as one named under blocking.
function namedIn(reviewText, match) {
  const texts = { blocking: [], small: [], other: [] };
  let section = "other";
  for (const line of reviewText.split("\n")) {
    if (HEADING.test(line)) {
      const h = line.toLowerCase();
      section = h.includes("blocking") ? "blocking" : h.includes("small") ? "small" : "other";
    }
    texts[section].push(line);
  }
  for (const name of ["blocking", "small", "other"]) {
    const text = texts[name].join("\n");
    if (match.some((re) => re.test(text))) return name;
  }
  return "none";
}

function scoreCase({ reviewText, c, result }) {
  const structured = result?.structuredOutput;
  const verdict =
    structured !== null && typeof structured === "object" && typeof structured.verdict === "string"
      ? structured.verdict
      : "invalid";
  const defects = c.defects.map((d) => {
    const found = d.match.some((re) => re.test(reviewText));
    return { id: d.id, found, named_in: found ? namedIn(reviewText, d.match) : "none" };
  });
  const found = defects.filter((d) => d.found).length;
  const control = defects.length === 0;
  return {
    verdict,
    defects,
    caught: verdict === "needs-work" && found > 0,
    falseAlarm: control && verdict === "needs-work",
  };
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(rows, opts = {}) {
  const defectRows = rows.filter((r) => r.defects.length > 0);
  const caught = defectRows.filter((r) => r.caught).length;
  const verdicts = {};
  const tokens = { prompt: 0, cached: 0, output: 0 };
  for (const r of rows) {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    for (const key of Object.keys(tokens)) tokens[key] += r.tokens[key];
  }
  const foundCount = (r) => r.defects.filter((d) => d.found).length;
  const summary = {
    casesRun: rows.length,
    defectCasesCaught: {
      caught,
      total: defectRows.length,
      share: defectRows.length ? caught / defectRows.length : 0,
    },
    defectsFound: {
      found: rows.reduce((a, r) => a + foundCount(r), 0),
      total: rows.reduce((a, r) => a + r.defects.length, 0),
    },
    named_blocking: rows.reduce((a, r) => a + r.defects.filter((d) => d.named_in === "blocking").length, 0),
    named_small_only: rows.reduce((a, r) => a + r.defects.filter((d) => d.named_in === "small").length, 0),
    not_named: rows.reduce((a, r) => a + r.defects.filter((d) => d.named_in === "none").length, 0),
    verdicts,
    falseAlarms: rows.filter((r) => r.falseAlarm).length,
    invalidReviews: rows.filter((r) => r.verdict === "invalid").length,
    medianMinutes: median([...rows.map((r) => r.minutes)].sort((a, b) => a - b)),
    tokens,
  };
  if (opts.repeats > 1) {
    const perCase = {};
    for (const r of rows) {
      const p = (perCase[r.case] ??= { caught: 0, total: 0, found: [] });
      p.total += 1;
      if (r.caught) p.caught += 1;
      p.found.push(foundCount(r));
    }
    summary.repeats = {
      caught: rows.filter((r) => r.caught).length,
      total: rows.length,
      defectsFound: { min: Math.min(...rows.map(foundCount)), max: Math.max(...rows.map(foundCount)) },
      perCase: Object.fromEntries(
        Object.entries(perCase).map(([name, p]) => [
          name,
          { caught: p.caught, total: p.total, defectsFound: { min: Math.min(...p.found), max: Math.max(...p.found) } },
        ]),
      ),
    };
  }
  return summary;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [headers, ...rows]
    .map((row, i) => row.map((cell, j) => (i > 0 && j > 0 ? cell.padStart(widths[j]) : cell.padEnd(widths[j]))).join("  "))
    .join("\n");
}

function formatConfig(name, entry) {
  const s = entry.summary;
  const verdicts = Object.entries(s.verdicts).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
  const lines = [
    `config ${name} (harness ${entry.harness})`,
    `  cases run            ${s.casesRun}`,
    `  defect cases caught  ${s.defectCasesCaught.caught} of ${s.defectCasesCaught.total} (${(s.defectCasesCaught.share * 100).toFixed(1)}%)`,
    `  defects found        ${s.defectsFound.found} of ${s.defectsFound.total}`,
  ];
  if (s.repeats) {
    lines.push(
      `  repeats caught       ${s.repeats.caught} of ${s.repeats.total}`,
      `  defects found range  ${s.repeats.defectsFound.min}-${s.repeats.defectsFound.max}`,
    );
  }
  lines.push(
    `  verdicts             ${verdicts}`,
    `  false alarms         ${s.falseAlarms}`,
    `  invalid reviews      ${s.invalidReviews}`,
    `  median minutes       ${s.medianMinutes.toFixed(1)}`,
    `  tokens               prompt ${s.tokens.prompt} cached ${s.tokens.cached} output ${s.tokens.output}`,
    "",
    renderTable(
      ["case", "repeat", "verdict", "defects", "named", "caught", "false-alarm", "minutes", "prompt", "cached", "output"],
      entry.rows.map((r) => [
        r.case,
        String(r.repeat),
        r.verdict,
        r.defects.length ? `${r.defects.filter((d) => d.found).length}/${r.defects.length}` : "-",
        r.defects.length ? r.defects.map((d) => d.named_in).join("+") : "-",
        r.caught ? "yes" : "no",
        r.falseAlarm ? "yes" : "no",
        r.minutes.toFixed(1),
        String(r.tokens.prompt),
        String(r.tokens.cached),
        String(r.tokens.output),
      ]),
    ),
  );
  if (s.repeats) {
    lines.push(
      "",
      "per case",
      renderTable(
        ["case", "repeats caught", "defects found"],
        Object.entries(s.repeats.perCase).map(([name, p]) => [
          name,
          `${p.caught} of ${p.total}`,
          `${p.defectsFound.min}-${p.defectsFound.max}`,
        ]),
      ),
    );
  }
  return lines.join("\n");
}

export async function main(argv, deps = {}) {
  const d = {
    fetch: (url) => fetch(url),
    spawn,
    clock: () => Date.now(),
    modelsFile: path.join(os.homedir(), ".pi", "agent", "models.json"),
    ...deps,
  };

  let opts;
  let loaded;
  try {
    opts = parseArgs(argv);
    loaded = loadCases(opts.cases);
  } catch (error) {
    process.stderr.write(`recipe-bench: ${error instanceof UsageError ? error.message : `unexpected: ${error.message}`}\n`);
    return error instanceof UsageError ? 2 : 1;
  }

  if (!opts.force) {
    const guard = await engineGuard(d).catch((error) => ({ code: 1, message: error.message }));
    if (guard) {
      process.stderr.write(`recipe-bench: ${guard.message}\n`);
      return guard.code;
    }
  }

  const out = path.resolve(opts.out ?? process.cwd());
  const runner = makeRunner(d);
  const startedAt = d.clock();
  const configs = {};
  let anyFailed = false;

  for (const config of opts.configs) {
    const rows = [];
    for (const c of loaded.cases) {
      for (let rep = 1; rep <= opts.repeat; rep++) {
        const runDir = path.join(out, c.name, config.name, String(rep));
        const reviewFile = path.join(runDir, "review.md");
        const briefFile = path.join(runDir, "brief.md");
        const resultFile = path.join(runDir, "result.json");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(briefFile, renderBrief(c, reviewFile));
        const args = [
          "dispatch",
          "--role", "reviewer",
          "--worktree",
          "--base", c.head,
          "--cwd", loaded.repo,
          "--brief-file", briefFile,
          "--output", reviewFile,
          "--gate", `recipe-gate verdict ${reviewFile}`,
          "--gate-json",
          "--result-file", resultFile,
          "--dir", runDir,
          "--timeout-ms", String(DISPATCH_TIMEOUT_MS),
        ];
        if (config.harness !== "pi") args.push("--harness", config.harness);
        let ran = false;
        let error = null;
        try {
          const r = await runner(args, { env: { ...process.env, RECIPE_RUNNER_CONFIG: config.file } });
          ran = r.code === 0;
          if (!ran) error = r.stderr.trim().slice(-ERROR_TAIL) || r.stdout.trim().slice(-ERROR_TAIL) || `exit ${r.code}`;
        } catch (spawnError) {
          error = spawnError.message;
        }
        if (!ran) anyFailed = true;
        const result = readJson(resultFile);
        let reviewText = "";
        try {
          reviewText = fs.readFileSync(reviewFile, "utf8");
        } catch {
          reviewText = "";
        }
        const usage = result?.usage ?? {};
        const scored = scoreCase({ reviewText, c, result });
        const row = {
          case: c.name,
          repeat: rep,
          expect: c.expect,
          reviewFile,
          resultFile,
          verdict: scored.verdict,
          defects: scored.defects,
          caught: scored.caught,
          falseAlarm: scored.falseAlarm,
          minutes: (result?.ms ?? 0) / 60000,
          tokens: { prompt: usage.prompt ?? 0, cached: usage.cached ?? 0, output: usage.output ?? 0 },
          ran,
        };
        if (error !== null) row.error = error;
        rows.push(row);
        process.stdout.write(`recipe-bench: ${config.name} ${c.name} ${rep}: verdict ${scored.verdict}${ran ? "" : ` (dispatch failed: ${error})`}\n`);
      }
    }
    configs[config.name] = { harness: config.harness, summary: summarize(rows, { repeats: opts.repeat }), rows };
  }

  const finishedAt = d.clock();
  const record = {
    casesFile: path.resolve(opts.cases),
    repo: loaded.repo,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    host: os.hostname(),
    configs,
  };
  fs.mkdirSync(out, { recursive: true });
  const benchFile = path.join(out, "bench.json");
  fs.writeFileSync(benchFile, `${JSON.stringify(record, null, 2)}\n`);
  for (const name of Object.keys(configs)) process.stdout.write(`${formatConfig(name, configs[name])}\n`);
  process.stdout.write(`${benchFile}\n`);
  return anyFailed ? 1 : 0;
}

const entry = process.argv[1];
if (entry && fs.realpathSync(entry) === fs.realpathSync(here)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`recipe-bench: ${error.message}\n`);
      process.exit(1);
    });
}
