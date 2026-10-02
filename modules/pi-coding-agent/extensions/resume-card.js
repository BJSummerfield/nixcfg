// Replaces pi's compaction summary with a fixed resume card; makes no model call.
//
// Install inside ~/.pi/agent/extensions: pi loads everything there into
// every session, the interactive one and every child alike.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const CARD_MAX_CHARS = 6000;
const MAX_PATH_CHARS = 200;
const MAX_MODIFIED = 30;
const MAX_PLAN_UNITS = 2;
const EXCERPT_WORDS = 300;
const TASK_MAX_CHARS = 1500;
const LEDGER_NAMES = ["state.json", "tasks.json", "PAUSE.md", "plan.md"];
const PLANS_IN_BASH = /(?:^|[\s'"=(])((?:[^\s'"()<>|;&]*\/)?\.plans\/[^\s'"()<>|;&]+)/g;
const MODEL_TAGS = /<\/?(?:think|tool_call|tool_response)>/g;
const COMPACTION_SUMMARY_PREFIXES = [
  "The conversation history before this point was compacted into the following summary:",
  "The following is a summary of a branch that this conversation came back from:",
];

function show(cwd, p) {
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  const picked = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
  return picked.slice(0, MAX_PATH_CHARS);
}

function toolCalls(entries) {
  const out = [];
  entries.forEach((e, index) => {
    const m = e?.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type === "toolCall" && b.arguments) out.push({ name: b.name, args: b.arguments, index });
    }
  });
  return out;
}

function planUnit(p) {
  const m = p.match(/^(.*?\.plans\/)([^/]+)(\/.*)?$/);
  if (!m) return undefined;
  if (m[3]) return { dir: m[1] + m[2] };
  return /\.\w+$/.test(m[2]) ? { file: p } : { dir: m[1] + m[2] };
}

function touchedPlanPaths(calls) {
  const touched = [];
  for (const c of calls) {
    if ((c.name === "read" || c.name === "write" || c.name === "edit") && typeof c.args.path === "string") {
      touched.push({ path: c.args.path, index: c.index });
    } else if (c.name === "bash" && typeof c.args.command === "string") {
      for (const match of c.args.command.matchAll(PLANS_IN_BASH)) {
        touched.push({ path: match[1], index: c.index });
      }
    }
  }
  return touched;
}

function ledgerOf(calls, cwd) {
  const touched = touchedPlanPaths(calls).filter((t) => t.path.includes(".plans/"));
  const unitKeyOf = (p) => {
    const unit = planUnit(p);
    if (!unit) return undefined;
    return unit.dir ? `dir:${unit.dir}` : `file:${unit.file}`;
  };
  const lastIndexByUnit = new Map();
  const unitByKey = new Map();
  for (const t of touched) {
    const unit = planUnit(t.path);
    if (!unit) continue;
    const key = unitKeyOf(t.path);
    unitByKey.set(key, unit);
    const prev = lastIndexByUnit.get(key) ?? -1;
    if (t.index > prev) lastIndexByUnit.set(key, t.index);
    if (unit.dir) {
      const touchedNames = unitByKey.get(`${key}:names`) ?? new Set();
      const rel = t.path.slice(unit.dir.length).replace(/^\//, "");
      if (LEDGER_NAMES.includes(rel)) touchedNames.add(rel);
      unitByKey.set(`${key}:names`, touchedNames);
    }
  }
  const ranked = [...lastIndexByUnit.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PLAN_UNITS);
  const result = [];
  for (const [key] of ranked) {
    const unit = unitByKey.get(key);
    if (unit.file) {
      result.push(show(cwd, unit.file));
      continue;
    }
    const touchedNames = unitByKey.get(`${key}:names`) ?? new Set();
    for (const name of LEDGER_NAMES) {
      const rel = `${unit.dir}/${name}`;
      if (touchedNames.has(name) || existsSync(resolve(cwd, rel))) result.push(show(cwd, rel));
    }
  }
  return result;
}

function modifiedOf(calls, cwd) {
  const paths = calls
    .filter((c) => (c.name === "write" || c.name === "edit") && typeof c.args.path === "string")
    .map((c) => show(cwd, c.args.path));
  return [...new Set(paths)].sort();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function isCompactionSummaryText(text) {
  return COMPACTION_SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function userTextOf(message) {
  if (message?.role !== "user") return undefined;
  const text = textOf(message.content).replace(MODEL_TAGS, "").trim();
  if (!text || isCompactionSummaryText(text)) return undefined;
  return text;
}

function firstUserTextOf(entries) {
  for (const e of entries) {
    if (e?.type !== "message") continue;
    const text = userTextOf(e.message);
    if (text) return text;
  }
  return undefined;
}

function latestUserTextOf(dropped) {
  for (let i = dropped.length - 1; i >= 0; i--) {
    const text = userTextOf(dropped[i]);
    if (text) return text;
  }
  return undefined;
}

function capChars(text) {
  return text.length > TASK_MAX_CHARS ? `${text.slice(0, TASK_MAX_CHARS)}…` : text;
}

function excerptOf(dropped) {
  for (let i = dropped.length - 1; i >= 0; i--) {
    const m = dropped[i];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(MODEL_TAGS, "")
      .trim();
    if (!text) continue;
    const words = text.split(/\s+/);
    return words.length > EXCERPT_WORDS ? `… ${words.slice(-EXCERPT_WORDS).join(" ")}` : words.join(" ");
  }
  return "(no assistant text in the removed span)";
}

function render({ taskText, latestText, ledgerLines, modifiedLines, excerpt, transcript }) {
  const taskBlock = taskText
    ? [`Task (first user message, verbatim, truncated):`, '"""', capChars(taskText), '"""']
    : [];
  const latestBlock =
    latestText && latestText !== taskText
      ? [`Latest instructions before the cut (verbatim, truncated):`, '"""', capChars(latestText), '"""']
      : [];
  return [
    "Earlier turns were removed to free context; their reasoning and tool output are gone.",
    ...taskBlock,
    ...latestBlock,
    "Before your next action, re-read these files (they are the source of truth):",
    ledgerLines,
    modifiedLines,
    "Last message before the cut (verbatim, truncated):",
    '"""',
    excerpt,
    '"""',
    `Full transcript: ${transcript} (read it in ranges with offset/limit; never whole).`,
    "Then continue from the most recent messages below.",
  ].join("\n");
}

export function buildCard({ taskText, latestText, ledger, modified, excerpt, sessionFile }) {
  const ledgerLines = ledger.length
    ? ledger.map((p) => `- ${p}`).join("\n")
    : "No plan ledger was touched in this session; if the task has one, re-read it now.";
  let shown = modified.slice(0, MAX_MODIFIED);
  const modifiedLinesFor = (list) => {
    const more = modified.length - list.length;
    return list.length
      ? ["Files modified so far:", ...list.map((p) => `- ${p}`), ...(more > 0 ? [`- … and ${more} more`] : [])].join(
          "\n",
        )
      : "No files were modified in this session.";
  };
  const transcript = sessionFile ?? "(not saved to disk)";

  let card = render({ taskText, latestText, ledgerLines, modifiedLines: modifiedLinesFor(shown), excerpt, transcript });
  while (card.length > CARD_MAX_CHARS && shown.length > 0) {
    shown = shown.slice(0, -1);
    card = render({ taskText, latestText, ledgerLines, modifiedLines: modifiedLinesFor(shown), excerpt, transcript });
  }

  return card.slice(0, CARD_MAX_CHARS);
}

export default function resumeCard(pi) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries } = event;
    const cwd = ctx.cwd;
    const calls = toolCalls(branchEntries ?? []);
    const ledger = ledgerOf(calls, cwd);
    const modified = modifiedOf(calls, cwd);
    const dropped = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
    const excerpt = excerptOf(dropped);
    const taskText = firstUserTextOf(branchEntries ?? []);
    const latestText = latestUserTextOf(dropped);
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    return {
      compaction: {
        summary: buildCard({ taskText, latestText, ledger, modified, excerpt, sessionFile }),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { card: 1, ledger, modifiedFiles: modified },
      },
    };
  });
}
