import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ESTIMATE = 100000;

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

function readEntries(dir, ownName) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (!match || name === ownName) continue;
    const file = path.join(dir, name);
    if (!pidAlive(Number(match[1]))) {
      fs.rmSync(file, { force: true });
      continue;
    }
    try {
      const tokens = Number(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(tokens)) live.push({ name, tokens, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  return live;
}

const total = (entries) => entries.reduce((sum, e) => sum + e.tokens, 0);

export async function reserveTokens(dir, { budget, tokens, id, pollMs = 2000, signal } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${process.pid}-${id}`;
  const file = path.join(dir, name);
  const fits = (others) =>
    budget == null || others.length === 0 || total(others) + tokens <= budget;

  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    fs.rmSync(file, { force: true });
  };

  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    const before = readEntries(dir, name);
    if (fits(before)) {
      const tmp = path.join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
      fs.writeFileSync(tmp, String(tokens));
      fs.renameSync(tmp, file);
      if (budget == null) return release;
      // Two reservers can both see room at once; the one that wrote later,
      // by (mtime, name), gives way so only one stays.
      const known = new Set(before.map((e) => e.name));
      const after = readEntries(dir, name);
      if (fits(after)) return release;
      const mtimeMs = fs.statSync(file).mtimeMs;
      const earlier = after.some(
        (e) =>
          !known.has(e.name) && (e.mtimeMs < mtimeMs || (e.mtimeMs === mtimeMs && e.name < name)),
      );
      if (!earlier) return release;
      fs.rmSync(file, { force: true });
    }
    await sleep(pollMs, signal);
  }
}

export function roleEstimate(sizingFile, role) {
  try {
    const sizing = JSON.parse(fs.readFileSync(sizingFile, "utf8"));
    const peak = sizing?.roles?.[role]?.peak_p90;
    return Number.isFinite(peak) ? peak : DEFAULT_ESTIMATE;
  } catch {
    return DEFAULT_ESTIMATE;
  }
}
