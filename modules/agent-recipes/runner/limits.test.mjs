/**
 * Behaviour tests for the runner's concurrency limits. Run by `nix flake check`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bigLock, procStartTime, reserveTokens, roleEstimate, semaphore } from "./limits.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-limits-"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => wait(30);
const sizingFile = fileURLToPath(new URL("../sizing/sizing.json", import.meta.url));

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(child.stdout.toString());
}

async function pending(promise) {
  let state = "pending";
  promise.then(
    () => (state = "settled"),
    () => (state = "settled"),
  );
  await tick();
  return state === "pending";
}

// semaphore
{
  const sem = semaphore(2);
  let running = 0;
  let peak = 0;
  const order = [];
  const work = async (n) => {
    const release = await sem.acquire();
    order.push(n);
    running += 1;
    peak = Math.max(peak, running);
    await wait(10);
    running -= 1;
    release();
    release();
  };
  await Promise.all([1, 2, 3, 4, 5, 6].map(work));
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);

  const one = semaphore(1);
  const first = await one.acquire();
  first();
  first();
  const second = await one.acquire();
  assert.ok(await pending(one.acquire()), "double release must not add a slot");
  second();
}

// two holders in one process serialize
{
  const file = path.join(tmp, "serial", "big.lock");
  const release = await bigLock(file, { pollMs: 20 });
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^${process.pid} \\d+\n$`));
  const second = bigLock(file, { pollMs: 20 });
  assert.ok(await pending(second));
  release();
  release();
  const releaseSecond = await second;
  assert.ok(fs.existsSync(file));
  releaseSecond();
  assert.ok(!fs.existsSync(file));
}

// a lock naming a dead pid is taken over
{
  const file = path.join(tmp, "dead.lock");
  fs.writeFileSync(file, `${deadPid()} 12345\n`);
  const release = await bigLock(file, { pollMs: 20 });
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^${process.pid} `));
  release();
}

// a live pid with a different start time is stale
{
  const file = path.join(tmp, "reused.lock");
  fs.writeFileSync(file, `${process.pid} ${Number(procStartTime(process.pid)) + 1}\n`);
  const release = await bigLock(file, { pollMs: 20 });
  assert.equal(fs.readFileSync(file, "utf8").split(" ")[1].trim(), procStartTime(process.pid));
  release();
}

// a live holder is never taken over
{
  const file = path.join(tmp, "live.lock");
  const content = `${process.ppid} ${procStartTime(process.ppid)}\n`;
  fs.writeFileSync(file, content);
  const controller = new AbortController();
  const waiting = bigLock(file, { pollMs: 20, signal: controller.signal });
  const outcome = assert.rejects(waiting, /stopped/);
  await wait(100);
  controller.abort(new Error("stopped"));
  await outcome;
  assert.equal(fs.readFileSync(file, "utf8"), content);
}

// a stale lock is kept while the holder's child is still running
{
  const file = path.join(tmp, "child.lock");
  const content = `${deadPid()} 12345\n`;
  fs.writeFileSync(file, content);
  let gone = false;
  const holderChildGone = () => gone;
  const controller = new AbortController();
  const blocked = bigLock(file, { pollMs: 20, signal: controller.signal, holderChildGone });
  const outcome = assert.rejects(blocked, /stopped/);
  await wait(100);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  controller.abort(new Error("stopped"));
  await outcome;

  const later = bigLock(file, { pollMs: 20, holderChildGone });
  assert.ok(await pending(later));
  gone = true;
  const release = await later;
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^${process.pid} `));
  release();
}

// two waiters racing for one stale lock: exactly one gets it
{
  const file = path.join(tmp, "race.lock");
  fs.writeFileSync(file, `${deadPid()} 12345\n`);
  const releases = [];
  const racers = [0, 1, 2].map((i) =>
    bigLock(file, { pollMs: 20 }).then((release) => {
      releases.push({ i, release });
      return i;
    }),
  );
  await wait(150);
  assert.equal(releases.length, 1);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^${process.pid} `));
  releases[0].release();
  await wait(150);
  assert.equal(releases.length, 2);
  releases[1].release();
  await Promise.all(racers);
  assert.equal(releases.length, 3);
  releases[2].release();
  assert.ok(!fs.existsSync(file));
}

// an abort rejects a waiter before it ever polls
{
  const file = path.join(tmp, "aborted.lock");
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await assert.rejects(bigLock(file, { signal: controller.signal }), /stopped/);
  assert.ok(!fs.existsSync(file));
}

// token reservations
{
  const dir = path.join(tmp, "inflight");
  const first = await reserveTokens(dir, { budget: 150000, tokens: 100000, id: "a", pollMs: 20 });
  assert.equal(fs.readFileSync(path.join(dir, `${process.pid}-a`), "utf8"), "100000");
  const second = reserveTokens(dir, { budget: 150000, tokens: 100000, id: "b", pollMs: 20 });
  assert.ok(await pending(second));
  first();
  first();
  const releaseSecond = await second;
  assert.ok(!fs.existsSync(path.join(dir, `${process.pid}-a`)));
  assert.ok(fs.existsSync(path.join(dir, `${process.pid}-b`)));
  releaseSecond();
  assert.deepEqual(fs.readdirSync(dir), []);

  const lone = await reserveTokens(dir, { budget: 150000, tokens: 200000, id: "c", pollMs: 20 });
  lone();

  const smalls = await Promise.all(
    ["d", "e", "f"].map((id) => reserveTokens(dir, { budget: 150000, tokens: 50000, id, pollMs: 20 })),
  );
  assert.equal(fs.readdirSync(dir).length, 3);
  smalls.forEach((release) => release());

  const free = await Promise.all(
    ["g", "h"].map((id) => reserveTokens(dir, { budget: null, tokens: 900000, id })),
  );
  free.forEach((release) => release());

  let inside = 0;
  let most = 0;
  await Promise.all(
    ["i", "j", "k"].map(async (id) => {
      const release = await reserveTokens(dir, { budget: 150000, tokens: 100000, id, pollMs: 20 });
      inside += 1;
      most = Math.max(most, inside);
      await wait(40);
      inside -= 1;
      release();
    }),
  );
  assert.equal(most, 1, "only one 100000 reservation fits a 150000 budget");

  const orphan = path.join(dir, `${deadPid()}-x`);
  fs.writeFileSync(orphan, "140000");
  const afterOrphan = await reserveTokens(dir, { budget: 150000, tokens: 100000, id: "m", pollMs: 20 });
  assert.ok(!fs.existsSync(orphan), "a dead pid's entry is deleted");
  afterOrphan();
}

// role estimates
{
  assert.equal(
    roleEstimate(sizingFile, "scout"),
    JSON.parse(fs.readFileSync(sizingFile, "utf8")).roles.scout.peak_p90,
  );
  assert.equal(roleEstimate(sizingFile, "no-such-role"), 100000);
  assert.equal(roleEstimate(path.join(tmp, "missing.json"), "scout"), 100000);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("limits tests passed");
