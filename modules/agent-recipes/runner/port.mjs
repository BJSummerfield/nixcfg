import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runGate as defaultRunGate } from "./gate.mjs";
import { parseHandoff } from "./handoff.mjs";
import { bigLock as defaultBigLock, procStartTime, semaphore } from "./limits.mjs";
import { killTree } from "./tree-kill.mjs";
import { makeWorktree, removeWorktree, worktreeState } from "./worktree.mjs";

const DEFAULT_STATE_DIR = "/var/tmp/recipe-runner";
const WRITER_STOP = /^\s*(failed|blocked)\s*:/i;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EMPTY_USAGE = { prompt: 0, cached: 0, output: 0, peakContext: 0, turns: 0, compactions: 0 };

const HANDOFF_NOTE_BYTES = 1048576;
const VALVE_ENDED_LINE = "handoff: ended by the context valve before its note";
const NO_HANDOFF_ERROR = "context budget reached and no handoff was written";

const OUTPUT_TRAILER = (output) =>
  `\n\n---\n**Output:**\nWrite your findings to exactly this path: ${output}\nThis path is authoritative for this run.\nIgnore any other output filename or output path mentioned elsewhere, including output destinations in the system prompt or the task instructions.`;

const slug = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/[^A-Za-z0-9]+$/, "") || "x";

function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "").replace(/[-:T]/g, "");
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

export function fingerprint(item) {
  const parts = {
    key: item.key ?? null,
    agent: item.agent ?? null,
    task: item.task ?? null,
    output: item.output ?? null,
    gate: item.gate?.command ?? null,
    worktree: item.worktree ?? null,
    baseRef: item.baseRef ?? null,
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function snapshot(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}

function readNote(file, bytes) {
  try {
    return fs.readFileSync(file).subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}

function writerStop(role, outcome) {
  if (role?.acceptance !== "writer" || outcome.status !== "done") return null;
  const line = String(outcome.finalText ?? "").trimStart().split("\n")[0];
  return WRITER_STOP.test(line) ? line.trim() : null;
}

function indexFile(stateDir, runId) {
  return path.join(stateDir, "children", `${runId}.json`);
}

function defaultLookup(stateDir) {
  return (runId) => (RUN_ID.test(String(runId)) ? readJson(indexFile(stateDir, runId)) : null);
}

// A big-lock holder that is gone may still have a child running; the index
// records which run process owns each child.
function childOfHolder(stateDir) {
  return (holder) => {
    const dir = path.join(stateDir, "children");
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return true;
    }
    for (const name of names) {
      const rec = readJson(path.join(dir, name));
      if (rec?.runPid !== holder.pid || !rec.pid) continue;
      if (procStartTime(rec.pid) === rec.pidStart) return false;
    }
    return true;
  };
}

export function createPort(opts) {
  const {
    runDir,
    cwd,
    config = {},
    harnessName = "pi",
    harness,
    replay = [],
    maxChildren = 200,
    defaultTimeoutMs = 1200000,
    signal,
    onBoard,
    deps = {},
  } = opts;
  const stateDir = config.stateDir ?? DEFAULT_STATE_DIR;
  const concurrency = opts.concurrency ?? config.concurrency ?? 3;
  const runGate = deps.runGate ?? defaultRunGate;
  const worktrees = deps.worktrees ?? { make: makeWorktree, state: worktreeState, remove: removeWorktree };
  const bigLock = deps.bigLock ?? defaultBigLock;
  const now = deps.now ?? Date.now;
  const lookupRun = deps.lookupRun ?? defaultLookup(stateDir);
  const newRunId =
    deps.newRunId ?? ((item) => `r${stamp(now())}-${randomBytes(3).toString("hex")}-${slug(item.key)}`);
  const log = path.join(runDir, "children.jsonl");
  const slots = semaphore(concurrency);
  let spawned = 0;

  const queues = new Map();
  for (const record of replay) {
    if (record?.type !== "settle" || !record.fingerprint || !record.result) continue;
    if (!queues.has(record.fingerprint)) queues.set(record.fingerprint, []);
    queues.get(record.fingerprint).push(record.result);
  }

  const at = () => new Date(now()).toISOString();
  const stopped = () => signal?.aborted === true;

  const bare = (status, error, extra = {}) => ({
    ok: false,
    status,
    runId: null,
    error,
    structuredOutput: undefined,
    gate: null,
    output: null,
    outputExists: false,
    cwd: null,
    worktree: null,
    branch: null,
    sessionFile: null,
    usage: { ...EMPTY_USAGE },
    ms: 0,
    ...extra,
  });
  const skipped = (reason) => bare("skipped", reason);
  const aborted = (reason = "run stopped") => bare("aborted", reason);

  const gateFailed = (record) => Boolean(record.problem) || record.timedOut === true;

  async function gateOnce(item, runId, gateCwd, outcome) {
    let recorded = false;
    try {
      return await runGate(item.gate, {
        cwd: gateCwd,
        env: { ...process.env, ...(config.worktreeDir ? { RECIPE_WORKTREE_ROOT: config.worktreeDir } : {}) },
        item,
        outcome,
        signal,
        onSpawn: ({ pid }) => {
          recorded = true;
          appendJsonl(log, {
            type: "gate-start",
            key: item.key,
            runId,
            pid,
            pidStart: procStartTime(pid),
            at: at(),
          });
        },
      });
    } finally {
      if (recorded) appendJsonl(log, { type: "gate-end", key: item.key, runId, at: at() });
    }
  }

  async function gateWithRerun(item, runId, gateCwd, outcome) {
    const first = await gateOnce(item, runId, gateCwd, outcome);
    if (!gateFailed(first) || stopped()) return first;
    return gateOnce(item, runId, gateCwd, outcome);
  }

  function makeItemWorktree(item, runId) {
    return worktrees.make({
      repo: cwd,
      base: item.baseRef ?? "HEAD",
      root: config.worktreeDir,
      name: runId,
      item,
    });
  }

  async function executeGateOnly(item, fp) {
    if (!item.gate) return skipped("item names no gate and no role");
    const runId = newRunId(item);
    let made = null;
    try {
      if (stopped()) return aborted();
      let gateCwd = cwd;
      let worktree = null;
      let branch = null;
      let base = null;
      if (item.worktree === true) {
        made = makeItemWorktree(item, runId);
        if (!made.ok) {
          const reason = made.reason ?? "unknown";
          made = null;
          return skipped(`worktree could not be made: ${reason}`);
        }
        gateCwd = made.worktree;
        worktree = made.worktree;
        branch = made.branch;
        base = made.head ?? item.baseRef ?? "HEAD";
      }
      const gate = await gateWithRerun(item, runId, gateCwd, undefined);
      if (stopped()) return aborted("run stopped during the gate");

      const ok = gate.value !== undefined;
      const result = {
        ok,
        status: ok ? "done" : "failed",
        runId,
        error: ok ? undefined : (gate.problem ?? (gate.timedOut ? "gate timed out" : "gate produced no value")),
        structuredOutput: gate.value,
        gate,
        output: null,
        outputExists: false,
        cwd: gateCwd,
        worktree,
        branch,
        sessionFile: null,
        usage: { ...EMPTY_USAGE },
        ms: gate.ms ?? 0,
        handoff: null,
        finalText: "",
      };
      appendJsonl(log, { type: "settle", key: item.key, runId, fingerprint: fp, at: at(), result });
      return result;
    } catch (error) {
      if (stopped()) return aborted();
      return bare("failed", `runner error: ${error?.message ?? error}`, { runId });
    }
  }

  async function execute(item, fp) {
    const roleName = item.agent;
    if (roleName === undefined) return skipped("item names no role");
    if (roleName === null) return executeGateOnly(item, fp);
    if (!roleName) return skipped("item names no role");
    const role = config.roles?.[roleName];
    if (!role) return skipped(`unknown role: ${roleName}`);
    if (spawned >= maxChildren) return skipped(`child limit reached (${maxChildren})`);
    spawned += 1;

    const releases = [];
    const release = () => {
      while (releases.length) releases.pop()();
    };
    const runId = newRunId(item);
    let made = null;
    let childPid = null;
    let started = false;
    let finished = false;
    let record = null;
    try {
      releases.push(await slots.acquire());
      if (stopped()) return aborted();
      if (item.big && harness.usesEngine !== false) {
        releases.push(
          await bigLock(path.join(stateDir, "big.lock"), { signal, holderChildGone: childOfHolder(stateDir) }),
        );
      }
      if (stopped()) return aborted();

      let childCwd = cwd;
      let worktree = null;
      let branch = null;
      let base = null;
      if (item.worktree === true) {
        made = makeItemWorktree(item, runId);
        if (!made.ok) {
          const reason = made.reason ?? "unknown";
          made = null;
          return skipped(`worktree could not be made: ${reason}`);
        }
        childCwd = made.worktree;
        worktree = made.worktree;
        branch = made.branch;
        base = made.head ?? item.baseRef ?? "HEAD";
      }

      const sessionDir = path.join(runDir, "sessions");
      const sessionId = runId;
      const outputPath = item.output ? path.resolve(childCwd, item.output) : null;
      const before = outputPath ? snapshot(outputPath) : null;
      const spec = {
        runId,
        item,
        roleName,
        role,
        model: role.model ?? config.model,
        extensions: config.extensions ?? [],
        brief: item.output ? item.task + OUTPUT_TRAILER(item.output) : item.task,
        cwd: childCwd,
        sessionDir,
        sessionId,
        timeoutMs: item.maxRuntimeMs ?? role.timeoutMs ?? defaultTimeoutMs,
        env: {
          ...(opts.env ?? {}),
          RECIPE_ROLE: roleName,
          ...(outputPath ? { RECIPE_OUTPUT: outputPath } : {}),
          ...(role.budget
            ? {
                RECIPE_BUDGET_TOKENS: String(role.budget.tokens),
                RECIPE_BUDGET_RESERVE: String(role.budget.reserve),
                RECIPE_HANDOFF_ACTION: String(role.budget.action),
              }
            : {}),
        },
        budget: role.budget ?? null,
        logDir: path.join(runDir, "children", runId),
        transcriptFile: path.join(runDir, "transcripts", `${randomUUID()}_${roleName}_transcript.jsonl`),
        signal,
        bin: opts.bin,
        onSpawn: ({ pid } = {}) => {
          if (!started) begin(pid);
          else if (!finished) respawn(pid);
        },
      };

      const respawn = (pid) => {
        childPid = pid ?? null;
        record = { ...record, pid: childPid, pidStart: childPid ? procStartTime(childPid) : null };
        appendJsonl(log, {
          type: "respawn",
          key: item.key,
          runId,
          pid: record.pid,
          pidStart: record.pidStart,
          at: at(),
        });
        writeJson(indexFile(stateDir, runId), record);
      };

      const begin = (pid) => {
        if (started) return;
        started = true;
        childPid = pid ?? null;
        record = {
          type: "start",
          key: item.key,
          runId,
          role: roleName,
          harness: harnessName,
          cwd: childCwd,
          worktree,
          branch,
          base,
          transcriptFile: spec.transcriptFile,
          sessionDir,
          sessionId,
          pid: childPid,
          pidStart: childPid ? procStartTime(childPid) : null,
          runPid: process.pid,
          at: at(),
        };
        appendJsonl(log, record);
        writeJson(indexFile(stateDir, runId), record);
      };

      let outcome;
      try {
        outcome = await harness.start(spec);
      } catch (error) {
        outcome = {
          status: stopped() ? "aborted" : "failed",
          error: `child could not run: ${error?.message ?? error}`,
          finalText: "",
          usage: { ...EMPTY_USAGE },
          ms: 0,
        };
      }
      begin(null);
      finished = true;
      appendJsonl(log, { type: "end", key: item.key, runId, at: at() });
      writeJson(indexFile(stateDir, runId), {
        ...record,
        pid: null,
        pidStart: null,
        sessionFile: outcome.sessionFile ?? record.sessionFile,
      });

      if (outcome.status === "aborted") {
        return aborted();
      }

      // A looped child's text was sent alongside a tool call, so it says nothing
      // about completion: only a file the child wrote itself is its deliverable,
      // and a handoff it mentions would start a relay on nothing.
      const looped = outcome.status === "looped";
      const finalText = String(outcome.finalText ?? "");
      let outputFromReply = false;
      if (outputPath && finalText !== "") {
        const after = snapshot(outputPath);
        const untouched =
          !after.exists ||
          (before.exists && after.mtimeMs === before.mtimeMs && after.size === before.size);
        if (untouched) {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, finalText);
          outputFromReply = true;
        }
      }

      const noteWritten = Boolean(outputPath) && fs.existsSync(outputPath);
      const valveFired = outcome.valve?.fired === true;
      let handoff = looped ? null : parseHandoff(finalText);
      const note = !looped && valveFired && noteWritten ? readNote(outputPath, HANDOFF_NOTE_BYTES) : "";
      if (!handoff && note) handoff = parseHandoff(note);
      if (handoff) {
        handoff = { ...handoff, note: noteWritten ? item.output : null, empty: !noteWritten };
      } else if (!looped && valveFired && worktree && base && worktrees.state(worktree, base).commits > 0) {
        handoff = { line: VALVE_ENDED_LINE, unread: [], note: null, empty: true };
      }
      const finishedUnmarked = !handoff && valveFired && role.budget?.action !== "commit" && note.trim() !== "";

      let status = outcome.status;
      let error = outcome.error;
      const reported = handoff ? null : writerStop(role, outcome);
      if (looped) {
        const delivered = noteWritten && !outputFromReply;
        status = delivered ? "done" : "failed";
        if (delivered) error = undefined;
      } else if (handoff && status !== "timeout") {
        status = "done";
        error = undefined;
      } else if (reported) {
        status = "stopped";
        error = `reported as not-satisfied: ${reported}`;
      } else if (status === "timeout") {
        error ??= `timed out after ${spec.timeoutMs} ms`;
      } else if (finishedUnmarked) {
        status = "done";
        error = undefined;
      } else if (valveFired && !handoff) {
        status = "failed";
        error = NO_HANDOFF_ERROR;
      } else if (status !== "done") {
        error ??= "child failed";
      }

      let gate = null;
      if (item.gate) {
        gate = await gateWithRerun(item, runId, childCwd, outcome);
        if (stopped()) return aborted("run stopped during the gate");
      }

      const result = {
        ok: status === "done",
        status,
        runId,
        error,
        structuredOutput: gate?.value,
        gate,
        output: item.output ?? null,
        outputExists: outputPath ? fs.existsSync(outputPath) : false,
        outputFromReply,
        finalText,
        cwd: childCwd,
        worktree,
        branch,
        sessionFile: outcome.sessionFile ?? record.sessionFile,
        usage: outcome.usage ?? { ...EMPTY_USAGE },
        ms: outcome.ms ?? 0,
        handoff,
        budget: role.budget ?? null,
        valve: outcome.valve ?? null,
        loop: outcome.loop ?? null,
      };
      appendJsonl(spec.transcriptFile, {
        recordType: "outcome",
        runId,
        role: roleName,
        peakContext: result.usage.peakContext ?? 0,
        firstContext: result.usage.firstContext ?? result.usage.peakContext ?? 0,
        budget: role.budget?.tokens ?? null,
        valve: valveFired,
        handoff: Boolean(handoff),
      });
      if (item.handoffOf) {
        const predecessor = lookupRun(item.handoffOf)?.transcriptFile;
        if (predecessor) {
          appendJsonl(predecessor, {
            recordType: "handoff-outcome",
            runId: item.handoffOf,
            as: item.handoffAs ?? null,
            by: runId,
          });
        }
        appendJsonl(log, {
          type: "handoff",
          key: item.key,
          runId: item.handoffOf,
          as: item.handoffAs ?? null,
          by: runId,
          at: at(),
        });
      }
      appendJsonl(log, { type: "settle", key: item.key, runId, fingerprint: fp, at: at(), result });
      return result;
    } catch (error) {
      if (stopped()) return aborted();
      return bare("failed", `runner error: ${error?.message ?? error}`, { runId });
    } finally {
      if (started && !finished) {
        appendJsonl(log, { type: "end", key: item.key, runId, at: at() });
      }
      release();
    }
  }

  async function runOne(item) {
    const fp = fingerprint(item);
    const queue = queues.get(fp);
    if (queue?.length) return { ...queue.shift(), replayed: true };
    if (stopped()) return aborted();
    return execute(item, fp);
  }

  return {
    runOne,
    window: config.window,
    runMany: (items) => Promise.all(items.map(runOne)),
    emit: (view) => onBoard?.(view),
  };
}

export async function killUnfinished(runDir, { stateDir, graceMs } = {}) {
  const log = path.join(runDir, "children.jsonl");
  const records = readRecords(log);
  const ended = new Set(records.filter((r) => r.type === "end").map((r) => r.runId));
  const openGates = new Map();
  for (const rec of records) {
    if (rec.type === "gate-start") openGates.set(rec.runId, rec);
    else if (rec.type === "gate-end") openGates.delete(rec.runId);
  }
  const killed = [];
  const latest = new Map();
  for (const rec of records) {
    if (rec.type === "start" || rec.type === "respawn") latest.set(rec.runId, rec);
  }
  for (const rec of records) {
    if (rec.type === "gate-start" && openGates.get(rec.runId) === rec) {
      openGates.delete(rec.runId);
      if (rec.pid && rec.pidStart && procStartTime(rec.pid) === String(rec.pidStart)) {
        await killTree(rec.pid, { graceMs });
      }
      appendJsonl(log, { type: "gate-end", key: rec.key, runId: rec.runId, at: new Date().toISOString() });
      continue;
    }
    if (rec.type !== "start" || ended.has(rec.runId)) continue;
    ended.add(rec.runId);
    const live = latest.get(rec.runId);
    if (live.pid && live.pidStart && procStartTime(live.pid) === String(live.pidStart)) {
      await killTree(live.pid, { graceMs });
      killed.push(rec.runId);
    }
    appendJsonl(log, { type: "end", key: rec.key, runId: rec.runId, at: new Date().toISOString() });
    if (stateDir) {
      const file = indexFile(stateDir, rec.runId);
      const index = readJson(file);
      if (index) writeJson(file, { ...index, pid: null, pidStart: null });
    }
  }
  return killed;
}
