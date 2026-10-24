import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readStat(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name is parenthesised and may itself contain spaces and parens.
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const rest = text.slice(close + 2).split(" ");
  return { pid: Number(pid), state: rest[0], ppid: Number(rest[1]), pgid: Number(rest[2]) };
}

function snapshot() {
  const rows = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const row = readStat(name);
    if (row) rows.push(row);
  }
  return rows;
}

function treeOf(rows, root) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const row of byParent.get(queue.shift()) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      queue.push(row.pid);
      if (row.state !== "Z") found.push({ pid: row.pid, ppid: row.ppid, pgid: row.pgid });
    }
  }
  return found;
}

export function descendants(pid) {
  return treeOf(snapshot(), pid);
}

export function watchTree(pid, { intervalMs = 2000 } = {}) {
  const seen = new Set();
  const sample = () => {
    const rows = snapshot();
    const self = rows.find((row) => row.pid === pid);
    if (self) seen.add(self.pgid);
    for (const row of treeOf(rows, pid)) seen.add(row.pgid);
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    groups: () => new Set(seen),
    stop: () => clearInterval(timer),
  };
}

function send(target, signal) {
  try {
    process.kill(target, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function killTree(pid, { groups = [], graceMs = 3000 } = {}) {
  const mine = readStat(process.pid)?.pgid;
  const groupSet = new Set();
  const loose = new Set();
  const collect = () => {
    const rows = snapshot();
    const tree = treeOf(rows, pid);
    const self = rows.find((row) => row.pid === pid && row.state !== "Z");
    if (self) tree.push(self);
    for (const row of tree) {
      if (row.pgid === mine) loose.add(row.pid);
      else groupSet.add(row.pgid);
    }
    groupSet.add(pid);
    groupSet.delete(mine);
    groupSet.delete(0);
  };
  for (const group of groups) groupSet.add(group);
  collect();

  // Our own group cannot be signalled without killing the caller, so its known
  // members are signalled one by one instead.
  const deliver = (signal) => {
    for (const group of groupSet) send(-group, signal);
    for (const target of loose) send(target, signal);
  };
  const signalled = [...groupSet];

  deliver("SIGTERM");
  await sleep(graceMs);
  collect();
  for (const group of groupSet) if (!signalled.includes(group)) signalled.push(group);
  deliver("SIGKILL");

  const remaining = () =>
    snapshot()
      .filter((row) => row.state !== "Z" && (groupSet.has(row.pgid) || loose.has(row.pid)))
      .map((row) => row.pid);
  let survivors = remaining();
  for (let waited = 0; survivors.length > 0 && waited < 1000; waited += 50) {
    await sleep(50);
    survivors = remaining();
  }
  return { signalled, survivors };
}
