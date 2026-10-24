import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate } from "./gate.mjs";

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
const real = fs.realpathSync(dir);

{
  const result = await runGate(
    { command: `printf '{"cwd":"%s"}' "$(pwd)"`, output: "json" },
    { cwd: dir },
  );
  assert.equal(result.exit, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.value, { cwd: real });
  assert.equal(result.problem, undefined);
}

{
  const result = await runGate({ command: "echo hello", output: "json" }, { cwd: dir });
  assert.equal(result.exit, 0);
  assert.equal(result.value, undefined);
  assert.match(result.problem, /^gate output is not JSON: /);
  assert.match(result.tail, /hello/);
}

{
  const result = await runGate(
    { command: `echo '{"a":1}'; echo oops >&2; exit 2`, output: "json" },
    { cwd: dir },
  );
  assert.equal(result.exit, 2);
  assert.deepEqual(result.value, { a: 1 });
  assert.match(result.tail, /oops/);
}

{
  const result = await runGate({ command: `head -c 5000 /dev/zero | tr '\\0' x` }, { cwd: dir });
  assert.equal(result.tail.length, 1500);
}

{
  const pidFile = path.join(dir, "grandchild.pid");
  const script = path.join(dir, "spawn.mjs");
  fs.writeFileSync(
    script,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
console.log(child.pid);
child.unref();
setTimeout(() => {}, 30000);
`,
  );
  const command = `"${process.execPath}" "${script}" > "${pidFile}" & sleep 0.2; wait`;
  const result = await runGate({ command, timeoutMs: 300 }, { cwd: dir });
  assert.equal(result.timedOut, true);
  assert.ok(result.ms < 10000);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  await sleep(100);
  assert.equal(alive(pid), false, "detached grandchild survived the timeout");
}

{
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runGate({ command: "sleep 30" }, { cwd: dir, signal: controller.signal });
  assert.ok(result.ms < 10000);
  assert.notEqual(result.exit, 0);
}

{
  const seen = [];
  const result = await runGate(
    {
      check: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    },
    { cwd: dir, item: "i", outcome: "o" },
  );
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.exit, 0);
  assert.deepEqual(seen, [{ cwd: dir, item: "i", outcome: "o" }]);
}

{
  const result = await runGate(
    {
      check: async () => {
        throw new Error("boom");
      },
    },
    { cwd: dir },
  );
  assert.equal(result.exit, 1);
  assert.equal(result.problem, "boom");
}

{
  const result = await runGate({ check: () => new Promise(() => {}), timeoutMs: 100 }, { cwd: dir });
  assert.equal(result.timedOut, true);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("gate tests passed");
