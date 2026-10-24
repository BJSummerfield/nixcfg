import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killTree, watchTree } from "../tree-kill.mjs";

const TAIL_CHARS = 1500;
const STREAM_GRACE_MS = 1000;

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
  const usage = { prompt: 0, cached: 0, output: 0, peakContext: 0, turns: 0, compactions: 0 };
  const outcome = (fields) => ({
    status: "failed",
    exitCode: null,
    signal: null,
    stopReason: null,
    finalText: "",
    usage,
    sessionFile: findSessionFile(spec.sessionDir, spec.sessionId) ?? spec.sessionFile ?? null,
    ms: Date.now() - startedAt,
    ...fields,
  });

  if (spec.signal?.aborted) return outcome({ status: "aborted" });

  if (spec.resume && !spec.sessionFile && !findSessionFile(spec.sessionDir, spec.sessionId)) {
    return outcome({ error: "no session file to resume" });
  }

  fs.mkdirSync(spec.logDir, { recursive: true });
  fs.mkdirSync(path.dirname(spec.transcriptFile), { recursive: true });
  const events = fs.createWriteStream(path.join(spec.logDir, "events.jsonl"), { flags: "a" });
  const stderrLog = fs.createWriteStream(path.join(spec.logDir, "stderr.log"), { flags: "a" });
  const transcript = fs.createWriteStream(spec.transcriptFile, { flags: "a" });
  const closeFiles = () =>
    Promise.all([events, stderrLog, transcript].map((stream) => new Promise((resolve) => stream.end(resolve))));

  const [command, ...prefix] = binOf(spec);
  const child = spawn(command, [...prefix, ...piArgv(spec)], {
    cwd: spec.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...spec.env, RECIPE_CHILD: "1" },
  });
  // pi attaches an argument starting with "@" as a file, and one argument
  // cannot exceed 128 KiB, so the brief goes in on stdin.
  child.stdin?.on("error", () => {});
  child.stdin?.end(spec.brief);

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

  let lastAssistant = null;
  let stderrTail = "";

  const onEvent = (event) => {
    if (event?.type === "compaction_end" && event.result) usage.compactions++;
    if (event?.type !== "message_end" || !event.message) return;
    const message = event.message;
    const record = { recordType: "message", message };
    if (message.role === "toolResult") {
      record.toolName = message.toolName;
      record.text = textOf(message.content);
    }
    transcript.write(`${JSON.stringify(record)}\n`);
    if (message.role !== "assistant") return;
    const u = message.usage ?? {};
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    usage.prompt += input + cacheRead + cacheWrite;
    usage.cached += cacheRead;
    usage.output += output;
    usage.peakContext = Math.max(usage.peakContext, u.totalTokens || input + output + cacheRead + cacheWrite);
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
    events.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
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
  const timer = spec.timeoutMs > 0 ? setTimeout(() => kill("timeout"), spec.timeoutMs) : null;
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
  await closeFiles();

  const fields = {
    exitCode: code,
    signal,
    stopReason: lastAssistant?.stopReason ?? null,
    finalText: lastAssistant?.finalText ?? "",
  };
  if (forced) {
    const error = forced === "timeout" ? `timed out after ${spec.timeoutMs}ms` : undefined;
    return outcome({ ...fields, status: forced, ...(error && { error }) });
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
}
