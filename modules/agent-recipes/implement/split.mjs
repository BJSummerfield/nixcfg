// Pure functions only: the graph owns the phases of a split.

export function splitItem(lib, t, o) {
  return lib.splitPlanItem({
    key: "split-" + t.id + "-" + o.n,
    splitDir: o.dir + "/split/" + t.id + "-" + o.n,
    parentId: t.id,
    parentEst: t.spec.est,
    taskFile: t.file,
    note: o.note || null,
    branch: t.branch,
    base: t.base,
    worktree: t.worktree,
    owns: t.spec.owns,
    handoffOf: t.runId,
  });
}

export function takePieces(lib, t, gate, o) {
  const made = lib.acceptSplit(t.track, gate, {
    parentId: t.id,
    parentEst: t.spec.est,
    parentOwns: t.spec.owns,
    taken: o && o.taken,
  });
  if (!made.ok) return made;
  const pieces = made.pieces.map(function (p) {
    return {
      id: p.id,
      spec: p,
      file: p.file,
      track: lib.handoffTrack(t.track),
      parent: t.id,
      baseRef: "refs/heads/" + t.branch,
      base: t.head,
      level: t.level,
      next: "implement",
    };
  });
  return { ok: true, pieces: pieces, problem: null };
}

function piecesOf(t, byId) {
  return Object.keys(byId)
    .map(function (id) {
      return byId[id];
    })
    .filter(function (p) {
      return p.parent === t.id;
    });
}

export function piecesStatus(t, byId) {
  const mine = piecesOf(t, byId);
  const aside = mine.find(function (p) {
    return p.state === "set_aside" || p.state === "skipped";
  });
  if (aside) return { status: "blocked", piece: aside };
  if (mine.length > 0 && mine.every((p) => p.state === "done")) return { status: "ready", piece: null };
  return { status: "waiting", piece: null };
}

// `tips` are the piece tasks themselves, which is what the graph's merge state takes.
export function joinSpec(t, dir, n, integration, byId) {
  return {
    scope: t.id,
    kind: "task",
    id: t.id,
    branch: integration + "-split-" + t.id + "-" + n,
    tips: piecesOf(t, byId || {}),
    onto: "refs/heads/" + t.branch,
    dir: dir + "/split/" + t.id + "-" + n + "/join",
  };
}

export function reviewRange(t, joinedBranch) {
  return t.base + ".." + joinedBranch;
}
