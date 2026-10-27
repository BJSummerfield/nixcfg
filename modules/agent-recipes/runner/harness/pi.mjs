import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HANDOFF_TIMEOUT_MS, budgetTrigger, handoffEnd, valveRecord } from "../budget.mjs";
import { handoffPrompt } from "../handoff.mjs";
import { killTree, watchTree } from "../tree-kill.mjs";
import { recordSpawn } from "./spawn-log.mjs";

const TAIL_CHARS = 1500;
const STREAM_GRACE_MS = 1000;
// Partial-message events repeat the whole message so far on every delta.
const STREAMING_EVENTS = new Set(["message_update", "tool_execution_update"]);

// The local model sometimes repeats the same turn with the same results
// forever, and a pi child only ends on a turn without tool calls.
export const LOOP_REPEATS = 4;

const toolList = (tools) => (Array.isArray(tools) ? tools.join(",") : typeof tools === "string" ? tools : "");

const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

export function piArgv(spec) {
  const role = spec.role ?? {};
  const argv = ["--mode", "json", "--no-skills", "--no-prompt-templates"];
  if (role.prompt) argv.push("--system-prompt", role.prompt);
  if (spec.model) argv.push("--model", spec.model);
  if (role.thinking) argv.push("--thinking", role.thinking);
  const tools = toolList(role.tools);
  if (tools) argv.push("--tools", tools);
  for (const extension of spec.extensions ?? []) argv.push("-e", extension);
  if (spec.resume) {
    argv.push("--session", spec.sessionFile ?? findSessionFile(spec.sessionDir, spec.sessionId));
  } else {
    argv.push("--session-dir", spec.sessionDir, "--session-id", spec.sessionId ?? spec.runId);
  }
  return argv;
}

function binOf(spec) {
  if (spec.bin) return spec.bin;
  if (process.env.RECIPE_PI_BIN) return JSON.parse(process.env.RECIPE_PI_BIN);
  return ["pi"];
}

function findSessionFile(dir, sessionId) {
  if (!dir || !sessionId) return null;
  const suffix = `_${sessionId}.jsonl`;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith(suffix)) {
        return full;
      }
    }
    return null;
  };
  return walk(dir);
}

export async function start(spec) {
  const startedAt = Date.now();
  const usage = { prompt: 0, cached: 0, output: 0, peakContext: 0, firstContext: 0, turns: 0, compactions: 0 };
  let valve = null;
  let writeContext = null;
  let commitContext = null;
  const trigger = budgetTrigger(spec.budget);
  const outcome = (fields) => ({
    status: "failed",
    exitCode: null,
    signal: null,
    stopReason: null,
    finalText: "",
    usage,
    valve,
    sessionFile: findSessionFile(spec.sessionDir, spec.sessionId) ?? spec.sessionFile ?? null,
    ms: Date.now() - startedAt,
    ...fields,
  });

  if (spec.signal?.aborted) return outcome({ status: "aborted" });

  fs.mkdirSync(spec.logDir, { recursive: true });
  fs.mkdirSync(path.dirname(spec.transcriptFile), { recursive: true });
  const events = fs.createWriteStream(path.join(spec.logDir, "events.jsonl"), { flags: "a" });
  const stderrLog = fs.createWriteStream(path.join(spec.logDir, "stderr.log"), { flags: "a" });
  const transcript = fs.createWriteStream(spec.transcriptFile, { flags: "a" });
  const closeFiles = () =>
    Promise.all([events, stderrLog, transcript].map((stream) => new Promise((resolve) => stream.end(resolve))));

  const [command, ...prefix] = binOf(spec);

  let lastAssistant = null;
  let turn = null;
  let prevTurnKey = null;
  let repeats = 0;
  let loopInfo = null;

  const completeTurn = (pending, kill) => {
    turn = null;
    if (loopInfo) return;
    const key = JSON.stringify([
      ...pending.calls.map((call) => [call.name, call.arguments]),
      ...pending.results.map((result) => [result.text, result.isError]),
    ]);
    repeats = prevTurnKey === key ? repeats + 1 : 1;
    prevTurnKey = key;
    if (repeats >= LOOP_REPEATS) {
      loopInfo = { tool: pending.calls[0].name, repeats: LOOP_REPEATS };
      kill("looped");
    }
  };

  async function runProcess({ argv, brief, timeoutMs, processEnv = {}, handoff = false, endRule = null }) {
    const env = { ...process.env, ...spec.env, RECIPE_CHILD: "1", ...processEnv };
    recordSpawn(spec.logDir, { command, argv: [...prefix, ...argv], cwd: spec.cwd, env });
    const child = spawn(command, [...prefix, ...argv], {
      cwd: spec.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    // pi attaches an argument starting with "@" as a file, and one argument
    // cannot exceed 128 KiB, so the brief goes in on stdin.
    child.stdin?.on("error", () => {});
    child.stdin?.end(brief);

    let spawnError = null;
    let gone = false;
    const exited = new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        gone = true;
        resolve({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => {
        gone = true;
        resolve({ code, signal });
      });
    });

    let stderrTail = "";
    let budgetHit = null;

    const onEvent = (event) => {
      if (event?.type === "compaction_end" && event.result) usage.compactions++;
      if (event?.type === "message_end" && event.message?.role === "custom" && event.message.customType === "budget-valve-thrash") {
        // a run the valve is ending for compaction thrash must not hand off
        trigger.stop();
      }
      if (event?.type === "turn_end" && event.message?.role === "assistant") {
        const u = event.message.usage ?? {};
        const context = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        const calls = (Array.isArray(event.message.content) ? event.message.content : [])
          .filter((block) => block?.type === "toolCall")
          .map((block) => ({
            id: block.id,
            tool: block.name,
            // tool paths in the child's events are relative to the child's working directory
            path:
              typeof block.arguments?.path === "string" ? path.resolve(spec.cwd ?? ".", block.arguments.path) : block.arguments?.path,
            command: block.arguments?.command,
          }));
        const results = (Array.isArray(event.toolResults) ? event.toolResults : []).map((result) => ({
          id: result?.toolCallId,
          isError: result?.isError === true,
        }));
        if (handoff) {
          if (endRule.observe({ context, calls, results })) {
            valve.ended = true;
            kill("budget");
          }
        } else {
          // turn_end is the first event after the turn's tool results, so a
          // kill here never loses the result of a call that ran
          const hit = trigger.observe({ context, calls });
          if (hit) {
            budgetHit = hit;
            kill("budget");
          }
        }
      }
      if (event?.type !== "message_end" || !event.message) return;
      const message = event.message;
      const record = { recordType: "message", message };
      if (message.role === "toolResult") {
        record.toolName = message.toolName;
        record.text = textOf(message.content);
        if (turn && turn.results.length < turn.calls.length) {
          turn.results.push({ text: record.text, isError: message.isError === true });
          if (turn.results.length === turn.calls.length) completeTurn(turn, kill);
        }
      }
      transcript.write(`${JSON.stringify(record)}\n`);
      if (message.role === "user") {
        prevTurnKey = null;
        repeats = 0;
        return;
      }
      if (message.role !== "assistant") return;
      if (turn) completeTurn(turn, kill);
      const u = message.usage ?? {};
      const input = u.input ?? 0;
      const output = u.output ?? 0;
      const cacheRead = u.cacheRead ?? 0;
      const cacheWrite = u.cacheWrite ?? 0;
      usage.prompt += input + cacheRead + cacheWrite;
      usage.cached += cacheRead;
      usage.output += output;
      const context = u.totalTokens || input + output + cacheRead + cacheWrite;
      usage.peakContext = Math.max(usage.peakContext, context);
      const calls = Array.isArray(message.content) ? message.content.filter((b) => b?.type === "toolCall") : [];
      if (writeContext === null && calls.some((b) => b.name === "write" || b.name === "edit")) writeContext = context;
      if (commitContext === null && calls.some((b) => b.name === "bash" && /git commit/.test(String(b.arguments?.command ?? "")))) {
        commitContext = context;
      }
      usage.firstContext = writeContext ?? commitContext ?? usage.peakContext;
      if (!handoff) {
        if (calls.length > 0) turn = { calls: calls.map((b) => ({ name: b.name, arguments: b.arguments })), results: [] };
        else {
          prevTurnKey = null;
          repeats = 0;
        }
      }
      usage.turns++;
      lastAssistant = {
        stopReason: message.stopReason ?? null,
        errorMessage: message.errorMessage,
        finalText: textOf(message.content),
      };
    };

    const onLine = (line) => {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        events.write(`${line}\n`);
        return;
      }
      if (!STREAMING_EVENTS.has(event?.type)) events.write(`${line}\n`);
      onEvent(event);
    };

    const streamsDone = [];
    if (child.stdout) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      child.stdout.on("data", (chunk) => {
        pending += decoder.write(chunk);
        let at;
        while ((at = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
      });
      child.stdout.on("error", () => {});
      streamsDone.push(
        new Promise((resolve) =>
          child.stdout.once("close", () => {
            onLine(pending + decoder.end());
            pending = "";
            resolve();
          }),
        ),
      );
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => {
        stderrLog.write(text);
        stderrTail = (stderrTail + text).slice(-TAIL_CHARS);
      });
      child.stderr.on("error", () => {});
      streamsDone.push(new Promise((resolve) => child.stderr.once("close", resolve)));
    }

    const watcher = child.pid ? watchTree(child.pid) : null;
    let forced = null;
    let killing = Promise.resolve();
    const kill = (status) => {
      if (forced || gone || !child.pid) return;
      forced = status;
      killing = killTree(child.pid, { groups: [...watcher.groups()] }).catch(() => {});
    };
    const timer = timeoutMs > 0 ? setTimeout(() => kill("timeout"), timeoutMs) : null;
    const onAbort = () => kill("aborted");
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    if (child.pid) spec.onSpawn?.({ pid: child.pid });

    const { code, signal } = await exited;
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
    // A grandchild that kept the pipes open must not keep the harness waiting.
    const grace = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, STREAM_GRACE_MS);
    await Promise.all(streamsDone);
    clearTimeout(grace);
    await killing;
    watcher?.stop();

    return { code, signal, spawnError, stderrTail, forced, budgetHit, timeoutMs };
  }

  const finish = async (run) => {
    await closeFiles();
    const { code, signal, spawnError, stderrTail, forced, timeoutMs } = run;
    const fields = {
      exitCode: code,
      signal,
      stopReason: lastAssistant?.stopReason ?? null,
      finalText: lastAssistant?.finalText ?? "",
    };
    if (forced) {
      let error;
      if (forced === "timeout") error = `timed out after ${timeoutMs}ms`;
      if (forced === "looped") error = `repeated ${loopInfo.tool} ${LOOP_REPEATS} times with the same result`;
      return outcome({ ...fields, status: forced, ...(error && { error }), ...(forced === "looped" && { loop: loopInfo }) });
    }

    const stopReason = lastAssistant?.stopReason;
    const failed =
      spawnError !== null ||
      code !== 0 ||
      lastAssistant === null ||
      stopReason === "error" ||
      stopReason === "aborted" ||
      stopReason === "length";
    if (!failed) return outcome({ ...fields, status: "done" });

    const error = spawnError
      ? spawnError.message
      : stopReason === "length"
        ? "output limit reached"
        : lastAssistant?.errorMessage ||
        stderrTail.trim() ||
        (code !== 0 ? `exit ${code ?? signal}` : "no assistant message");
    return outcome({ ...fields, status: "failed", error });
  };

  let run = await runProcess({ argv: piArgv(spec), brief: spec.brief, timeoutMs: spec.timeoutMs });
  if (run.forced === "budget") {
    // an abort that arrived with the budget kill stops the whole run; only a
    // clean kill hands off
    if (spec.signal?.aborted) return finish({ ...run, forced: "aborted" });
    valve = valveRecord(spec.budget, run.budgetHit.tokens, false);
    turn = null;
    prevTurnKey = null;
    repeats = 0;
    // a resumed pi that exits without an assistant message must not report
    // the first process's text
    lastAssistant = null;
    const session = spec.sessionFile ?? findSessionFile(spec.sessionDir, spec.sessionId);
    const output = spec.item?.output ? path.resolve(spec.cwd ?? ".", spec.item.output) : null;
    run = await runProcess({
      // without the session file pi can still resume by session id
      argv: session ? piArgv({ ...spec, resume: true, sessionFile: session }) : piArgv(spec),
      brief: handoffPrompt(spec.budget.action, { output: spec.item?.output, tokens: run.budgetHit.tokens }),
      timeoutMs: spec.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS,
      // the valve, while guarded, refuses everything but the note and, for
      // commit, git
      processEnv: { RECIPE_HANDOFF_GUARD: "1" },
      handoff: true,
      endRule: handoffEnd(spec.budget, { firedTokens: run.budgetHit.tokens, output }),
    });
  }
  return finish(run);
}
