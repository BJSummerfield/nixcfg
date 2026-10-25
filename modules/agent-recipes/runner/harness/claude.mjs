import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killTree, watchTree } from "../tree-kill.mjs";
import { recordSpawn } from "./spawn-log.mjs";

// Claude children call a remote API, so they never need the local engine's lock.
export const usesEngine = false;

const TAIL_CHARS = 1500;
const STREAM_GRACE_MS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EFFORT = { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

const toolList = (tools) =>
  (Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(",") : [])
    .map((tool) => String(tool).trim())
    .filter(Boolean)
    .join(",");

// Claude Code only accepts a uuid as a session id, while the runner names a
// session after its run id. The same name always maps to the same uuid, so a
// resumed child finds the session its first run created.
export function claudeSessionId(sessionId) {
  if (UUID.test(sessionId)) return sessionId.toLowerCase();
  const hex = createHash("sha1").update(String(sessionId)).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export function claudeArgv(spec) {
  const role = spec.role ?? {};
  const claude = role.claude ?? {};
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  const agent = claude.agent ?? spec.roleName;
  if (agent) argv.push("--agent", agent);
  if (claude.model) argv.push("--model", claude.model);
  const effort = EFFORT[role.thinking];
  if (effort) argv.push("--effort", effort);
  const tools = toolList(claude.tools);
  if (tools) argv.push("--tools", tools, "--allowedTools", tools);
  argv.push("--permission-prompts", "none");
  const session = claudeSessionId(spec.sessionId ?? spec.runId);
  argv.push(spec.resume ? "--resume" : "--session-id", session);
  return argv;
}

// Claude Code keeps a session at <config dir>/projects/<working directory with
// every non-alphanumeric character as "-">/<uuid>.jsonl. The runner's cwd may
// be reached through a symlink, so both spellings are tried, then any project.
export function claudeSessionFile(spec) {
  const config = spec.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projects = path.join(config, "projects");
  const name = `${claudeSessionId(spec.sessionId ?? spec.runId)}.jsonl`;
  const cwds = [spec.cwd];
  try {
    cwds.push(fs.realpathSync(spec.cwd));
  } catch {
    // The directory is gone; the unresolved spelling is all there is.
  }
  const candidates = cwds.filter(Boolean).map((cwd) => path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), name));
  try {
    for (const entry of fs.readdirSync(projects)) candidates.push(path.join(projects, entry, name));
  } catch {
    // No projects directory yet; only the computed spellings remain.
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function binOf(spec) {
  if (spec.bin) return spec.bin;
  if (process.env.RECIPE_CLAUDE_BIN) return JSON.parse(process.env.RECIPE_CLAUDE_BIN);
  return ["claude"];
}

const PARENT_SESSION_VARS = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

function childEnv(spec) {
  const env = { ...process.env, ...spec.env, RECIPE_CHILD: "1" };
  for (const name of PARENT_SESSION_VARS) delete env[name];
  return env;
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
    sessionFile: claudeSessionFile(spec),
    ms: Date.now() - startedAt,
    ...fields,
  });

  if (spec.signal?.aborted) return outcome({ status: "aborted" });

  fs.mkdirSync(spec.logDir, { recursive: true });
  const events = fs.createWriteStream(path.join(spec.logDir, "events.jsonl"), { flags: "a" });
  const stderrLog = fs.createWriteStream(path.join(spec.logDir, "stderr.log"), { flags: "a" });
  const closeFiles = () => Promise.all([events, stderrLog].map((stream) => new Promise((resolve) => stream.end(resolve))));

  const [command, ...prefix] = binOf(spec);
  const argv = [...prefix, ...claudeArgv(spec)];
  const env = childEnv(spec);
  recordSpawn(spec.logDir, { command, argv, cwd: spec.cwd, env });
  const child = spawn(command, argv, {
    cwd: spec.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  // The brief can exceed one argument's size limit, so it goes in on stdin.
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

  // One API message can arrive as several assistant lines (one per content
  // block) that repeat the same usage, so the last line per message id wins.
  const messages = new Map();
  let anonymous = 0;
  let result = null;
  let stderrTail = "";

  const onEvent = (event) => {
    if (event?.type === "system" && event.subtype === "compact_boundary") usage.compactions++;
    if (event?.type === "assistant" && event.message) {
      messages.set(event.message.id ?? `anonymous-${anonymous++}`, event.message.usage ?? {});
    }
    if (event?.type === "result") result = event;
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

  for (const u of messages.values()) {
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;
    usage.prompt += input + cacheRead + cacheCreation;
    usage.cached += cacheRead;
    usage.output += output;
    usage.peakContext = Math.max(usage.peakContext, input + cacheRead + cacheCreation + output);
    usage.turns++;
  }

  const fields = {
    exitCode: code,
    signal,
    stopReason: result?.stop_reason ?? result?.terminal_reason ?? null,
    finalText: typeof result?.result === "string" ? result.result : "",
  };
  if (forced) {
    const error = forced === "timeout" ? `timed out after ${spec.timeoutMs}ms` : undefined;
    return outcome({ ...fields, status: forced, ...(error && { error }) });
  }

  const failed =
    spawnError !== null || code !== 0 || result === null || result.is_error === true || result.subtype !== "success";
  if (!failed) return outcome({ ...fields, status: "done" });

  const reported = Array.isArray(result?.errors) ? result.errors.map((e) => e?.message ?? e).join("; ") : "";
  const error = spawnError
    ? spawnError.message
    : (result?.is_error && typeof result.result === "string" && result.result) ||
      reported ||
      (result && result.subtype !== "success" ? result.subtype : "") ||
      stderrTail.trim() ||
      (code !== 0 ? `exit ${code ?? signal}` : "no result line");
  return outcome({ ...fields, status: "failed", error });
}
