// Shows where a recipe run stands, from any shell, while it runs or after.
//
//   recipe-status <task dir> [--json]
//
// The runner keeps its files under <task dir>/runner/: status.json holds the
// run's state, pid and the board (the graph's last emit), and children.jsonl
// one `start` and one `settle` line per child. Children still running are the
// ones with a start and no settle, and failed ones exclude a child whose retry
// succeeded. A run recorded as running whose process is gone is shown as
// stopped.

import fs from "node:fs";
import path from "node:path";

class Usage extends Error {}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function bare(p) {
  return path.resolve(String(p)).replace(/\/+$/, "");
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function children(dir) {
  const started = new Map();
  const settled = new Map();
  const usage = { prompt: 0, cached: 0, output: 0, peakContext: 0 };
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "runner", "children.jsonl"), "utf8");
  } catch {
    return { running: [], done: 0, failed: [], usage };
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
  for (const r of settled.values()) {
    const u = r.usage || {};
    usage.prompt += u.prompt || 0;
    usage.cached += u.cached || 0;
    usage.output += u.output || 0;
    usage.peakContext = Math.max(usage.peakContext, u.peakContext || 0);
  }
  const running = [...started.keys()].filter((k) => !settled.has(k));
  const recovered = (k) => settled.has(k + "-retry") && settled.get(k + "-retry").ok !== false;
  const failed = [...settled].filter(([k, r]) => r.ok === false && !recovered(k)).map(([k]) => k);
  return { running, done: settled.size, failed, usage };
}

function stateOf(s) {
  const state = s.state || "unknown";
  return state === "running" && !alive(s.pid) ? "stopped (process gone)" : state;
}

function minutes(ms) {
  return `${Math.round(ms / 60000)} min`;
}

function render(dir, s, c, now) {
  const board = s.board || null;
  const lines = [];
  const t0 = s.startedAt ? new Date(s.startedAt).getTime() : NaN;
  const t1 = s.lastUpdate ? new Date(s.lastUpdate).getTime() : now;
  const started = Number.isNaN(t0) ? "?" : new Date(t0).toISOString().slice(0, 16).replace("T", " ");
  const age = Number.isNaN(t0) ? "" : `, ${minutes((s.state === "running" ? now : t1) - t0)}`;
  lines.push(`${dir}`);
  lines.push(`run ${s.pid ?? "?"}: ${stateOf(s)}, started ${started} UTC${age}`);
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
  const u = c.usage;
  lines.push(`usage: prompt ${u.prompt}, cached ${u.cached}, output ${u.output}, peak context ${u.peakContext}`);
  return lines.join("\n");
}

function main(argv, now) {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  if (rest.length !== 1) throw new Usage("usage: recipe-status <task dir> [--json]");
  const dir = bare(rest[0]);
  const statusFile = path.join(dir, "runner", "status.json");
  const s = readJson(statusFile);
  if (!s) return { code: 1, text: `recipe-status: no run found for ${dir} (no ${statusFile})` };
  const c = children(dir);
  if (json) {
    return {
      code: 0,
      text: JSON.stringify({ state: stateOf(s), pid: s.pid ?? null, board: s.board || null, children: { running: c.running, done: c.done, failed: c.failed }, usage: c.usage }),
    };
  }
  return { code: 0, text: render(dir, s, c, now) };
}

try {
  const { code, text } = main(process.argv.slice(2), Date.now());
  (code === 0 ? process.stdout : process.stderr).write(text + "\n");
  process.exit(code);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(err instanceof Usage ? 2 : 1);
}
