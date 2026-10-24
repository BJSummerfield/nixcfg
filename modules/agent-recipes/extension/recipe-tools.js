import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RECEIPT_CAP = 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cut(text, cap) {
  return text.length > cap ? `${text.slice(0, cap)}...` : text;
}

function absoluteDir(value, what) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
  return value;
}

function resultSummary(result) {
  if (!result) return "The dispatch produced no result.";
  const gate = result.gate
    ? `Gate exit ${result.gate.exit}${result.gate.timedOut ? " (timed out)" : ""}${result.gate.problem ? `: ${result.gate.problem}` : ""}.`
    : "No gate.";
  const usage = result.usage
    ? `Usage: prompt ${result.usage.prompt ?? 0}, cached ${result.usage.cached ?? 0}, output ${result.usage.output ?? 0}.`
    : "Usage unknown.";
  const output = result.output ? `Output: ${result.output}${result.outputExists ? "" : " (missing)"}.` : "No output path.";
  const error = result.error ? ` Error: ${result.error}.` : "";
  return `Dispatch ${result.status}.${error} ${output} ${gate} ${usage}`;
}

export default function recipeTools(pi, deps = {}) {
  const env = deps.env ?? process.env;
  if (env.RECIPE_CHILD === "1") return;
  const spawn = deps.spawn ?? nodeSpawn;
  const bin = env.RECIPE_RUN_BIN ? JSON.parse(env.RECIPE_RUN_BIN) : ["recipe-run"];
  let closed = false;

  pi.on("session_shutdown", () => {
    closed = true;
  });

  const wake = (customType, text, details) => {
    if (closed) return;
    pi.sendMessage(
      { customType, content: [{ type: "text", text }], display: true, details },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const openLog = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.openSync(file, "a");
  };

  pi.registerTool({
    name: "recipe_run",
    label: "Recipe run",
    description:
      "Start a recipe (research, plan, implement, investigate) as a background run, or resume an earlier one. " +
      "Returns at once with the task directory. You are woken once, with the receipt, when the run ends: " +
      "do not poll, sleep or check on it; end your turn or do other work.",
    parameters: {
      type: "object",
      properties: {
        recipe: { type: "string", enum: ["research", "plan", "implement", "investigate"] },
        args: { type: "object", description: "Recipe arguments; dir (or plan) is the absolute task directory" },
        cwd: { type: "string", description: "Working directory of the run; defaults to the session's" },
        harness: { type: "string" },
        timeoutMs: { type: "number" },
        maxChildren: { type: "number" },
        resume: { type: "boolean", description: "Resume the run recorded in the task directory" },
      },
      required: ["recipe", "args"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = params.args ?? {};
      const taskDir = absoluteDir(args.dir ?? args.plan, "args.dir or args.plan");
      const cwd = params.cwd ?? ctx?.cwd ?? process.cwd();
      const argv = params.resume
        ? [...bin, "resume", taskDir]
        : [
            ...bin,
            "run",
            params.recipe,
            "--args",
            JSON.stringify(args),
            "--cwd",
            cwd,
            ...(params.harness ? ["--harness", params.harness] : []),
            ...(params.timeoutMs != null ? ["--timeout-ms", String(params.timeoutMs)] : []),
            ...(params.maxChildren != null ? ["--max-children", String(params.maxChildren)] : []),
          ];
      const fd = openLog(path.join(taskDir, "runner", "runner.log"));
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ["ignore", fd, fd], env });
      } finally {
        fs.closeSync(fd);
      }
      child.on("error", () => {});
      child.on("exit", () => {
        const status = readJson(path.join(taskDir, "runner", "status.json"));
        const receipt = readJson(path.join(taskDir, "receipt.json"));
        const state = status?.state ?? "ended without a status";
        const text =
          `Recipe ${params.recipe} ${state}. Receipt: ${path.join(taskDir, "receipt.json")}` +
          (receipt ? `\n${cut(JSON.stringify(receipt), RECEIPT_CAP)}` : "");
        wake("recipe-run", text, { taskDir, recipe: params.recipe, state, receipt });
      });
      child.unref();
      const details = { taskDir, pid: child.pid };
      return {
        content: [
          {
            type: "text",
            text:
              `Started ${params.recipe} in ${taskDir} (pid ${child.pid}). You will be woken once when it ends. ` +
              "Do not poll or sleep; end your turn or do unrelated work.",
          },
        ],
        details,
      };
    },
  });

  pi.registerTool({
    name: "recipe_dispatch",
    label: "Recipe dispatch",
    description:
      "Run one child with a named role and a brief, through the recipe runner. Foreground (default) waits and " +
      "returns the result. With background: true it returns at once and you are woken once with the result; " +
      "do not poll.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string" },
        brief: { type: "string" },
        output: { type: "string" },
        gate: { type: "string", description: "Shell command run after the child" },
        gateJson: { type: "boolean" },
        gateTimeoutMs: { type: "number" },
        worktree: { type: "boolean" },
        base: { type: "string" },
        keepWorktree: { type: "boolean" },
        resume: { type: "string", description: "Run id of a child to continue" },
        timeoutMs: { type: "number" },
        cwd: { type: "string" },
        background: { type: "boolean" },
      },
      required: ["role", "brief"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = crypto.randomBytes(6).toString("hex");
      const dir = path.join(env.TMPDIR || os.tmpdir(), "recipe-dispatch", id);
      fs.mkdirSync(dir, { recursive: true });
      const briefFile = path.join(dir, "brief.md");
      const resultFile = path.join(dir, "result.json");
      fs.writeFileSync(briefFile, params.brief);
      const cwd = params.cwd ?? ctx?.cwd ?? process.cwd();
      const argv = [
        ...bin,
        "dispatch",
        "--role",
        params.role,
        "--brief-file",
        briefFile,
        "--dir",
        dir,
        "--result-file",
        resultFile,
        "--cwd",
        cwd,
        ...(params.output ? ["--output", params.output] : []),
        ...(params.gate ? ["--gate", params.gate] : []),
        ...(params.gateJson ? ["--gate-json"] : []),
        ...(params.gateTimeoutMs != null ? ["--gate-timeout-ms", String(params.gateTimeoutMs)] : []),
        ...(params.worktree ? ["--worktree"] : []),
        ...(params.base ? ["--base", params.base] : []),
        ...(params.keepWorktree ? ["--keep-worktree"] : []),
        ...(params.resume ? ["--resume", params.resume] : []),
        ...(params.timeoutMs != null ? ["--timeout-ms", String(params.timeoutMs)] : []),
      ];
      const fd = openLog(path.join(dir, "dispatch.log"));
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "ignore", fd], env });
      } finally {
        fs.closeSync(fd);
      }
      const exited = new Promise((resolve) => {
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
      });

      if (params.background) {
        exited.then(() => {
          const result = readJson(resultFile);
          wake("recipe-dispatch", `${resultSummary(result)} Result file: ${resultFile}`, { id, resultFile, result });
        });
        child.unref();
        return {
          content: [
            {
              type: "text",
              text: `Dispatched ${params.role} as ${id}. You will be woken once when it ends. Do not poll.`,
            },
          ],
          details: { id, resultFile },
        };
      }

      const onAbort = () => child.kill("SIGTERM");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      await exited;
      signal?.removeEventListener("abort", onAbort);
      const result = readJson(resultFile);
      return {
        content: [{ type: "text", text: `${resultSummary(result)} Result file: ${resultFile}` }],
        details: result ?? { ok: false, status: "failed", error: "no result file", resultFile },
      };
    },
  });
}
