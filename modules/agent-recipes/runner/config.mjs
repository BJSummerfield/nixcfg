import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  worktreeDir: "/var/tmp/pi-worktrees",
  stateDir: "/var/tmp/recipe-runner",
  concurrency: 3,
  inFlightTokens: null,
};

export function loadConfig(env = process.env) {
  const explicit = env.RECIPE_RUNNER_CONFIG;
  const file = explicit || path.join(os.homedir(), ".pi", "agent", "recipes", "roles.json");
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (explicit || error.code !== "ENOENT") {
      throw new Error(`cannot read the runner config ${file}: ${error.message}`);
    }
  }
  const config = { ...DEFAULTS, roles: {}, extensions: [] };
  for (const [name, value] of Object.entries(loaded)) {
    if (value !== null && value !== undefined) config[name] = value;
  }
  return config;
}
