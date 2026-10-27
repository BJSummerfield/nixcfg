import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function semaphore(n) {
  let free = n;
  const waiting = [];
  const releaser = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = waiting.shift();
      if (next) next(releaser());
      else free += 1;
    };
  };
  return {
    acquire() {
      if (free > 0) {
        free -= 1;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function abortError(signal) {
  return signal.reason ?? new Error("aborted");
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Field 22 of /proc/<pid>/stat. The command name is parenthesised and may
// contain spaces or parentheses, so fields are counted after the last ")".
export function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function parseHolder(text) {
  const match = /^(\d+) (\d+)\n?$/.exec(text);
  return match ? { pid: Number(match[1]), start: match[2] } : null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function tmpName(file) {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

const takeovers = new Map();

// Takeovers of one lock file run one at a time inside this process; across
// processes the compare-then-rename step is the only guard.
function inTakeover(file, fn) {
  const prev = takeovers.get(file) ?? Promise.resolve();
  const next = prev.then(fn);
  const tail = next.catch(() => {});
  takeovers.set(file, tail);
  tail.then(() => {
    if (takeovers.get(file) === tail) takeovers.delete(file);
  });
  return next;
}

export async function bigLock(file, { pollMs = 2000, signal, holderChildGone = () => true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `${process.pid} ${procStartTime(process.pid) ?? 0}\n`;

  const release = () => {
    if (readText(file) === content) fs.rmSync(file, { force: true });
  };
  const makeRelease = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };

  // Linking a finished temp file keeps creation exclusive while a reader
  // never sees a half-written lock.
  const tryCreate = () => {
    const tmp = tmpName(file);
    fs.writeFileSync(tmp, content);
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  const isStale = async (text) => {
    const holder = parseHolder(text);
    if (!holder) return false;
    const gone = !pidAlive(holder.pid) || procStartTime(holder.pid) !== holder.start;
    return gone && (await holderChildGone(holder));
  };

  const takeOver = (seen) =>
    inTakeover(file, async () => {
      if (readText(file) !== seen) return false;
      const tmp = tmpName(file);
      fs.writeFileSync(tmp, content);
      try {
        if (readText(file) !== seen) return false;
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      return readText(file) === content;
    });

  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    if (tryCreate()) return makeRelease();
    const seen = readText(file);
    if (seen !== null && (await isStale(seen)) && (await takeOver(seen))) return makeRelease();
    await sleep(pollMs, signal);
  }
}
