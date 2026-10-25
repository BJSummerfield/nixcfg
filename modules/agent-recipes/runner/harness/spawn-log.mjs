import fs from "node:fs";
import path from "node:path";

// argv is logged whole because the brief goes in on stdin, never in argv.
export function recordSpawn(logDir, { command, argv, cwd, env }) {
  const recipe = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("RECIPE_")));
  const line = JSON.stringify({ at: new Date().toISOString(), command, argv, cwd, env: recipe });
  try {
    fs.appendFileSync(path.join(logDir, "spawn.jsonl"), `${line}\n`);
  } catch {
    // The record is diagnostic; a child must still run without it.
  }
}
