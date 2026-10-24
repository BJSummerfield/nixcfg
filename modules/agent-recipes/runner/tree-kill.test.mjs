/**
 * Tree kill against a real process tree made only of node processes.
 *
 * runner (detached, own group)
 *   bash (detached, own group)
 *     probe (bash's group, ignores SIGTERM)
 *     mid (bash's group, exits early)
 *       orphan (detached, own group, re-parented once mid is gone)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { descendants, killTree, watchTree } from "./tree-kill.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};
const until = async (what, ready) => {
  for (let i = 0; i < 100; i++) {
    const value = ready();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-kill-"));
const script = path.join(dir, "node.mjs");
fs.writeFileSync(
  script,
  `import { spawn } from "node:child_process";
const role = process.argv[2];
const start = (name, detached) =>
  spawn(process.execPath, [${JSON.stringify(script)}, name], { detached, stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write(role + " " + process.pid + "\\n");
if (role === "runner") start("bash", true);
if (role === "bash") {
  start("probe", false);
  start("mid", false);
}
if (role === "probe") process.on("SIGTERM", () => {});
if (role === "mid") {
  start("orphan", true);
  setTimeout(() => process.exit(0), 1200);
} else {
  setInterval(() => {}, 1000);
}
`,
);

const pids = {};
const runner = spawn(process.execPath, [script, "runner"], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
let buffered = "";
runner.stdout.on("data", (chunk) => {
  buffered += chunk;
  for (const line of buffered.split("\n").slice(0, -1)) {
    const [role, pid] = line.split(" ");
    pids[role] = Number(pid);
  }
  buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
});

try {
  await until("the whole tree to start", () => ["bash", "probe", "mid", "orphan"].every((role) => pids[role]));
  const watcher = watchTree(runner.pid, { intervalMs: 100 });
  assert.equal(pids.runner, runner.pid);

  const seen = await until("descendants", () => {
    const found = descendants(runner.pid);
    return found.length >= 4 ? found : null;
  });
  const byPid = new Map(seen.map((row) => [row.pid, row]));
  assert.equal(byPid.get(pids.bash).ppid, runner.pid);
  assert.equal(byPid.get(pids.bash).pgid, pids.bash);
  assert.equal(byPid.get(pids.probe).pgid, pids.bash);
  assert.equal(byPid.get(pids.orphan).pgid, pids.orphan);
  assert.equal(byPid.has(runner.pid), false, "the root is not its own descendant");

  await until("mid to exit", () => !alive(pids.mid));
  assert.equal(
    descendants(runner.pid).some((row) => row.pid === pids.orphan),
    false,
    "the orphan has been re-parented away from the runner",
  );
  assert.ok(alive(pids.orphan));

  const groups = watcher.groups();
  assert.ok(groups.has(runner.pid), "the child's own group is remembered");
  assert.ok(groups.has(pids.bash), "the bash group is remembered");
  assert.ok(groups.has(pids.orphan), "the re-parented process's group is remembered");

  const started = Date.now();
  const outcome = await killTree(runner.pid, { groups, graceMs: 300 });
  watcher.stop();
  assert.deepEqual(outcome.survivors, []);
  assert.ok(outcome.signalled.includes(pids.bash));
  assert.ok(outcome.signalled.includes(pids.orphan));
  assert.ok(Date.now() - started >= 300, "the grace period is waited out for the stubborn probe");
  for (const role of ["runner", "bash", "probe", "orphan"]) {
    assert.equal(alive(pids[role]), false, `${role} is gone`);
  }
  assert.equal(alive(process.pid), true);

  const again = await killTree(runner.pid, { groups, graceMs: 50 });
  assert.deepEqual(again.survivors, [], "killing an already dead tree is not an error");

  const solo = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const soloOutcome = await killTree(solo.pid, { graceMs: 100 });
  assert.deepEqual(soloOutcome.survivors, []);
  assert.equal(alive(process.pid), true, "a child in the caller's own group is killed without killing the caller");
  await until("the solo child to be reaped", () => !alive(solo.pid));
} finally {
  for (const pid of Object.values(pids)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("tree-kill tests passed");
