/**
 * Runs a recipe script in pi-subagents' own workflow sandbox, with each child
 * answered by a test's fake `runs`. The dry runs call the script directly and
 * cannot see the sandbox's checks: the JSON shape of launch params, and that
 * every launch is awaited before the script returns.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function hostRun(source, runs, args) {
  const root = process.env.PI_SUBAGENTS;
  if (!root) throw new Error("PI_SUBAGENTS must name the pi-subagents package directory");
  const { runWorkflowScript } = await import(pathToFileURL(path.join(root, "src/workflows/scripted-workflow.js")).href);
  const result = await runWorkflowScript({
    script: source,
    args,
    launch: async (key, params) => (await runs.all([{ key, ...params }]))[0],
  });
  return result.value;
}
