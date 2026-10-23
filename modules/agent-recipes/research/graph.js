const MAX_SOURCES = 12;
const GAP_SOURCES = 6;
const MAX_ANGLES = 4;
const SYNTH_TOKENS = 70000;

const dir = args.dir;
const goal = args.goal;
const output = args.output;
const format =
  args.format || "a markdown document whose first section answers the goal, every claim carrying a URL and a quotation or location";
const maxSources = Math.min(args.maxSources || MAX_SOURCES, MAX_SOURCES);
const windowTokens = args.window || 221184;
const childMs = args.childTimeoutMs || 480000;
const bigMs = args.bigTimeoutMs || 2400000;

const STEPS = {
  synthesize: "the synthesis of the extracts into the requested output",
  review: "the review of the deliverable against its findings",
};

const sources = [];
const open = [];
const wholeRun = subjectOf(null);
let gapRound = false;
let nextK = 0;
let deliverable = null;

function extractFile(k, suffix) {
  return dir + "/raw/extract/extract-" + k + suffix + ".md";
}

function extractFor(rec, suffix, part) {
  return extractItem(
    "extract-" + rec.k + suffix,
    goal,
    rec.url,
    rec.angle,
    dir + "/pages/page-" + rec.k + suffix + ".md",
    extractFile(rec.k, suffix),
    part,
    childMs,
  );
}

function synthItem(key, files, out, mode, from) {
  const lines = ["Goal: " + goal, "Requested output: " + format];
  if (mode === "partial") {
    lines.push("Write a partial synthesis of these findings; another synthesizer merges it with the others.");
  } else if (mode === "combine") {
    lines.push("These are partial syntheses of one body of findings. Merge them into the requested output, keeping every citation.");
  } else if (mode === "update") {
    lines.push("Update the existing output at " + from + " with the new findings below: read it first, then write the full updated document to " + out + ".");
  }
  lines.push("Files to read, in ranges:");
  files.forEach(function (file) {
    lines.push("- " + file);
  });
  lines.push("Write the result to " + out);
  return node(key, "synthesizer", lines, out, { timeoutMs: bigMs, big: true });
}

function reviewItem(n, file, files) {
  const lines = [
    "Review a research deliverable (the research variant).",
    "Goal: " + goal,
    "Requested output: " + format,
    "Deliverable: " + deliverable,
    "Findings it rests on:",
  ];
  files.forEach(function (f) {
    lines.push("- " + f.file);
  });
  lines.push("Write the report to " + file);
  return node(n === 1 ? "review" : "review-" + n, "reviewer", lines, file, {
    gate: "recipe-gate gaps " + quote(file),
    timeoutMs: bigMs,
    big: true,
  });
}

function groupFiles(files, n) {
  const angles = {};
  files.forEach(function (f) {
    angles[f.angle] = true;
  });
  const byAngle = Object.keys(angles).length > 1;
  const units = {};
  const order = [];
  files.forEach(function (f, i) {
    const key = byAngle ? f.angle : String(i);
    if (!units[key]) {
      units[key] = { bytes: 0, files: [] };
      order.push(key);
    }
    units[key].bytes += f.bytes;
    units[key].files.push(f.file);
  });
  order.sort(function (a, b) {
    return units[b].bytes - units[a].bytes;
  });
  const groups = [];
  for (let i = 0; i < Math.min(n, order.length); i++) groups.push({ bytes: 0, files: [] });
  order.forEach(function (key) {
    let best = groups[0];
    groups.forEach(function (g) {
      if (g.bytes < best.bytes) best = g;
    });
    best.bytes += units[key].bytes;
    best.files = best.files.concat(units[key].files);
  });
  return groups.map(function (g) {
    return g.files;
  });
}

function okFiles(round) {
  const found = [];
  sources.forEach(function (rec) {
    if (rec.status !== "ok" || rec.round !== round) return;
    rec.files.forEach(function (f) {
      found.push({ file: f.file, bytes: f.bytes, angle: rec.angle });
    });
  });
  return found;
}

function counts() {
  const c = { ok: 0, failed: 0, over_cap: 0 };
  sources.forEach(function (rec) {
    if (rec.status === "ok") c.ok++;
    else if (rec.status === "over_cap") c.over_cap++;
    else c.failed++;
  });
  return c;
}

function view() {
  return { sources: counts(), gap_round: gapRound };
}

function finish(out) {
  return receipt({ output: out, sources: counts(), open: open, gap_round: gapRound });
}

function heal(step, signal, evidence, allowed) {
  board("diagnosing " + step, view());
  return diagnose(wholeRun, troubleOf(step, signal, evidence, allowed), dir, ["Goal: " + goal, "Requested output: " + format, "Task directory: " + dir], STEPS[step], childMs);
}

// Resolves to the deliverable's path, or null when a synthesizer failed.
function synthesize(files, split, tag, out) {
  if (split === 1) {
    return launch([synthItem("synthesis" + tag, files.map(function (f) { return f.file; }), out, "synthesis")]).then(function (r) {
      return r[0].ok ? r[0].file : null;
    });
  }
  const partials = [];
  const groups = groupFiles(files, split);
  let chain = Promise.resolve();
  groups.forEach(function (group, g) {
    chain = chain.then(function () {
      return launch([synthItem("synthesis-" + g + tag, group, dir + "/synthesis-" + g + tag + ".md", "partial")]).then(function (r) {
        if (r[0].ok) partials.push(r[0].file);
        else open.push("partial synthesis " + g + tag + " failed");
      });
    });
  });
  return chain.then(function () {
    if (partials.length === 0) return null;
    return launch([synthItem("synthesis-combine" + tag, partials, out, "combine")]).then(function (r) {
      return r[0].ok ? r[0].file : null;
    });
  });
}

const anglesFile = dir + "/angles.md";
const planned = await one(
  node(
    "angles",
    "planner",
    ["Job: angles.", "Goal: " + goal, "Requested output: " + format, "Write at most " + MAX_ANGLES + " angles to " + anglesFile + ", in the angles format."],
    anglesFile,
    { gate: "recipe-gate angles " + quote(anglesFile), timeoutMs: childMs },
  ),
);

let current;
if (passed(planned)) {
  current = planned.structuredOutput.angles.slice(0, MAX_ANGLES).map(function (a) {
    return { id: slugOf(a.id), question: a.question };
  });
} else {
  current = [{ id: "main", question: goal }];
  open.push("angles: the planner produced no usable list, so the goal was searched as one angle");
}

let gapAngles = [];

for (let round = 0; round < 2; round++) {
  board(round === 0 ? "searching" : "gap round: searching", view());
  const limit = round === 0 ? maxSources : Math.min(maxSources, GAP_SOURCES);

  const searches = await launch(
    current.map(function (angle) {
      return searchItem(goal, angle, dir + "/raw/search/search-" + angle.id + ".md", childMs);
    }),
  );

  const known = {};
  sources.forEach(function (rec) {
    known[rec.url] = true;
  });
  const picked = rankAndCap(sourcesFound(current, searches, known, open), limit);

  const recs = picked.map(function (p, j) {
    return { k: nextK + j, url: p.url, angle: p.angle, round: round, status: "ok", files: [], error: null };
  });
  nextK += recs.length;

  board(round === 0 ? "extracting" : "gap round: extracting", view());
  const first = recs.length ? await launch(recs.map(function (rec) { return extractFor(rec, "", ""); })) : [];
  const toSplit = [];
  recs.forEach(function (rec, j) {
    const r = first[j];
    const g = r.structuredOutput || {};
    if (!r.ok) {
      rec.status = "failed";
      rec.error = r.error || "failed";
    } else if (g.over_cap) {
      rec.status = "over_cap";
      toSplit.push(rec);
    } else if (!g.ok) {
      rec.status = "rejected";
      rec.error = g.reason || "no passages";
    } else {
      rec.files.push({ file: r.file, bytes: g.bytes });
    }
  });

  if (toSplit.length > 0) {
    const halves = [];
    toSplit.forEach(function (rec) {
      halves.push({ rec: rec, suffix: "a", part: "The page is large: cover only the first half of its sections, by its outline. Another extractor takes the second half." });
      halves.push({ rec: rec, suffix: "b", part: "The page is large: cover only the second half of its sections, by its outline. Another extractor took the first half." });
    });
    const second = await launch(halves.map(function (h) { return extractFor(h.rec, h.suffix, h.part); }));
    toSplit.forEach(function (rec) {
      rec.overHalves = 0;
    });
    halves.forEach(function (h, j) {
      const r = second[j];
      const g = r.structuredOutput || {};
      if (r.ok && g.ok) h.rec.files.push({ file: r.file, bytes: g.bytes });
      else if (r.ok && g.over_cap) h.rec.overHalves++;
      else h.rec.error = r.ok ? g.reason || "no passages" : r.error || "failed";
    });
    toSplit.forEach(function (rec) {
      if (rec.files.length > 0) rec.status = "ok";
      else rec.status = rec.overHalves > 0 ? "over_cap" : "failed";
      if (rec.files.length === 1) open.push("source " + rec.url + ": one half of the split failed");
    });
  }

  recs.forEach(function (rec) {
    sources.push(rec);
    if (rec.status !== "ok") open.push("source " + rec.url + ": " + rec.status + (rec.error ? " (" + rec.error + ")" : ""));
  });

  if (round === 0) {
    if (picked.length === 0) {
      open.push("no sources were found");
      return finish(null);
    }
    const files = okFiles(0);
    if (files.length === 0) {
      open.push("no extract passed its checks, so nothing was synthesized");
      return finish(null);
    }

    const bytes = files.reduce(function (sum, f) { return sum + f.bytes; }, 0);
    const est = Math.ceil(bytes / 4);
    const split = est <= 0.5 * windowTokens ? 1 : Math.max(2, Math.ceil(est / SYNTH_TOKENS));

    board("synthesizing", view());
    deliverable = await synthesize(files, split, "", output);
    if (!deliverable) {
      const d = await heal("synthesize", "the synthesizer failed twice", [dir + "/raw/extract"], ["retry", "decide"]);
      if (d) deliverable = await synthesize(files, split, "-2", sibling(output, "2"));
    }
    if (!deliverable) {
      open.push("the synthesizer failed, so there is no output");
      return finish(null);
    }

    let rg = null;
    let reviewFile = null;
    for (let n = 1; ; n++) {
      board("reviewing", view());
      reviewFile = n === 1 ? dir + "/review.md" : sibling(dir + "/review.md", String(n));
      const review = await one(reviewItem(n, reviewFile, files));
      reviewFile = review.file;
      rg = review.ok ? review.structuredOutput : null;
      if (!rg) {
        const d = await heal("review", "the reviewer failed: " + (review.error || "its gate did not run"), [review.file], ["retry", "decide"]);
        if (d) continue;
        break;
      }
      if (rg.verdict !== "invalid") break;
      const d = await heal("review", "the review's verdict could not be read", [review.file], ["continue", "retry", "decide"]);
      if (!d) break;
      if (d.action === "retry") continue;
      rg = Object.assign({}, rg, { verdict: d.verdict, clean: d.verdict === "clean" });
      break;
    }
    if (!rg) {
      open.push("the review failed or its gate did not run");
    } else {
      if (rg.verdict === "invalid") open.push("the review verdict could not be read; see " + reviewFile);
      else if (!rg.clean) open.push("review verdict " + rg.verdict + "; see " + reviewFile);
      gapAngles = list(rg.angles).slice(0, MAX_ANGLES).map(function (a) {
        return { id: "gap-" + slugOf(a.id), question: a.question };
      });
    }
    if (gapAngles.length === 0) break;
    gapRound = true;
    current = gapAngles;
  } else {
    gapAngles.forEach(function (a) {
      const usable = sources.some(function (rec) {
        return rec.round === 1 && rec.angle === a.id && rec.status === "ok";
      });
      if (!usable) open.push("gap " + a.id + " (" + a.question + "): no usable source");
    });
    const files = okFiles(1);
    if (files.length > 0) {
      const r = await one(synthItem("synthesis-update", files.map(function (f) { return f.file; }), sibling(deliverable, "updated"), "update", deliverable));
      if (r.ok) deliverable = r.file;
      else open.push("the final update failed; the output is the first synthesis");
    }
  }
}

return finish(deliverable);
