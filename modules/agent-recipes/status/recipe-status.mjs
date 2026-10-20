// Shows where a recipe run stands, from any shell, while it runs or after.
//
//   recipe-status <task dir> [--json]
//
// pi-subagents keeps each async run under $TMPDIR/pi-subagents/async-subagent-runs/<id>/:
// status.json holds the workflow's args, its state and every value the script
// emitted, and workflow-children.jsonl one `start` and one `settle` line per
// child. The run shown is the newest whose args name the task directory (the
// research and plan skills pass it as `dir`, the implement skill as `plan`).
// The board is the script's last emit; children still running are the ones
// with a start and no settle, and failed ones exclude a child whose retry
// succeeded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class Usage extends Error {}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runsRoot() {
  return path.join(process.env.TMPDIR || os.tmpdir(), "pi-subagents", "async-subagent-runs");
}

function bare(p) {
  return path.resolve(String(p)).replace(/\/+$/, "");
}

function findRun(dir) {
  const root = runsRoot();
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const status = readJson(path.join(root, name, "status.json"));
    const a = status && status.workflow && status.workflow.args;
    if (!a) continue;
    const target = a.dir ?? a.plan;
    if (!target || bare(target) !== dir) continue;
    if (!best || (status.startedAt || 0) > (best.status.startedAt || 0)) best = { dir: path.join(root, name), status };
  }
  return best;
}

function children(runDir) {
  const started = new Map();
  const settled = new Map();
  let text = "";
  try {
    text = fs.readFileSync(path.join(runDir, "workflow-children.jsonl"), "utf8");
  } catch {
    return { running: [], done: 0, failed: [] };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "start") started.set(r.key, r);
    if (r.type === "settle") settled.set(r.key, r.result || {});
  }
  const running = [...started.keys()].filter((k) => !settled.has(k));
  const recovered = (k) => settled.has(k + "-retry") && settled.get(k + "-retry").ok !== false;
  const failed = [...settled].filter(([k, r]) => r.ok === false && !recovered(k)).map(([k]) => k);
  return { running, done: settled.size, failed };
}

function minutes(ms) {
  return `${Math.round(ms / 60000)} min`;
}

function render(dir, run, now) {
  const s = run.status;
  const w = s.workflow || {};
  const board = (w.emits || []).at(-1) || null;
  const c = children(run.dir);
  const lines = [];
  const started = s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ") : "?";
  const age = s.startedAt ? `, ${minutes((s.state === "running" ? now : s.lastUpdate || now) - s.startedAt)}` : "";
  lines.push(`${dir}`);
  lines.push(`run ${path.basename(run.dir)}: ${s.state || "unknown"}, started ${started} UTC${age}`);
  if (board) {
    lines.push(`stage: ${board.stage}`);
    if (Array.isArray(board.tasks)) {
      for (const t of board.tasks) {
        const next = t.next ? `, next ${t.next}` : "";
        const extra = [t.fixes ? `${t.fixes} fix rounds` : "", t.heals ? `${t.heals} diagnoses` : ""].filter(Boolean).join(", ");
        lines.push(`  ${t.id.padEnd(20)} ${t.state}${next}${extra ? ` (${extra})` : ""}`);
      }
    } else if (typeof board.tasks === "number") {
      lines.push(`  plan: ${board.tasks} tasks, check ${board.plan_ok === null ? "not run" : board.plan_ok ? "ok" : "failing"}, review ${board.review ?? "none yet"}`);
    }
    if (board.sources) lines.push(`  sources: ${board.sources.ok} ok, ${board.sources.failed} failed, ${board.sources.over_cap} over the cap${board.gap_round ? ", gap round" : ""}`);
    for (const h of board.healed || []) lines.push(`  healed ${h.id ?? h.step}: ${h.action}, ${h.reason}`);
    for (const d of board.decide || []) lines.push(`  decide ${d.id ?? d.step}: ${d.question}`);
  } else {
    lines.push("stage: no board yet");
  }
  lines.push(`children: ${c.running.length} running${c.running.length ? ` (${c.running.join(", ")})` : ""}, ${c.done} settled${c.failed.length ? `, failed: ${c.failed.join(", ")}` : ""}`);
  return lines.join("\n");
}

function main(argv, now) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  if (rest.length !== 1) throw new Usage("usage: recipe-status <task dir> [--json]");
  const dir = bare(rest[0]);
  const run = findRun(dir);
  if (!run) return { code: 1, text: `recipe-status: no run found for ${dir} under ${runsRoot()}` };
  if (json) {
    const w = run.status.workflow || {};
    return {
      code: 0,
      text: JSON.stringify({ run: path.basename(run.dir), state: run.status.state, board: (w.emits || []).at(-1) || null, children: children(run.dir) }),
    };
  }
  return { code: 0, text: render(dir, run, now) };
}

try {
  const { code, text } = main(process.argv.slice(2), Date.now());
  (code === 0 ? process.stdout : process.stderr).write(text + "\n");
  process.exit(code);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
