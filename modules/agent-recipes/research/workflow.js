const MAX_SOURCES = 12;
const GAP_SOURCES = 6;
const MAX_ANGLES = 4;
const SYNTH_TOKENS = 70000;
const MAX_HEALS = 2;
const REASON_CHARS = 300;

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
const healed = [];
const decide = [];
let children = 0;
let gapRound = false;
let nextK = 0;
let deliverable = null;

function slug(text) {
  return String(text).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function passed(result) {
  return Boolean(result.ok && result.structuredOutput && result.structuredOutput.ok);
}

function sibling(file, tag) {
  return file.replace(/(\.md)?$/, "." + tag + "$1");
}

function short(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? flat.slice(0, REASON_CHARS) + "..." : flat;
}

function retryItem(item) {
  const moved = sibling(item.output, "retry");
  const copy = Object.assign({}, item, {
    key: item.key + "-retry",
    output: moved,
    task: item.task.split(item.output).join(moved),
  });
  if (item.gate) {
    copy.gate = Object.assign({}, item.gate, {
      command: item.gate.command.split(quote(item.output)).join(quote(moved)),
    });
  }
  return copy;
}

function launch(items) {
  children += items.length;
  return runs.all(items).then(function (first) {
    const merged = first.map(function (result, i) {
      return Object.assign({}, result, { file: items[i].output });
    });
    const again = [];
    const where = [];
    first.forEach(function (result, i) {
      if (!result.ok) {
        again.push(retryItem(items[i]));
        where.push(i);
      }
    });
    if (again.length === 0) return merged;
    children += again.length;
    return runs.all(again).then(function (second) {
      second.forEach(function (result, j) {
        merged[where[j]] = Object.assign({}, result, { file: again[j].output });
      });
      return merged;
    });
  });
}

function rankAndCap(found, limit) {
  const seen = {};
  const byAngle = {};
  const order = [];
  for (let i = 0; i < found.length; i++) {
    const item = found[i];
    if (seen[item.url]) continue;
    seen[item.url] = true;
    if (!byAngle[item.angle]) {
      byAngle[item.angle] = [];
      order.push(item.angle);
    }
    byAngle[item.angle].push(item);
  }
  for (let i = 0; i < order.length; i++) {
    const list = byAngle[order[i]];
    byAngle[order[i]] = list.filter((u) => u.kind === "primary").concat(list.filter((u) => u.kind !== "primary"));
  }
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let added = false;
    for (let i = 0; i < order.length && picked.length < limit; i++) {
      const item = byAngle[order[i]][round];
      if (item) {
        picked.push(item);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

function extractFile(k, suffix) {
  return dir + "/raw/extract/extract-" + k + suffix + ".md";
}

function extractItem(rec, suffix, part) {
  const file = extractFile(rec.k, suffix);
  const lines = [
    "Goal: " + goal,
    "URL: " + rec.url,
    "Angle: " + rec.angle,
    "Page: " + dir + "/pages/page-" + rec.k + suffix + ".md",
    "Output: " + file,
  ];
  if (part) lines.push(part);
  return {
    key: "extract-" + rec.k + suffix,
    agent: "extractor",
    task: lines.join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: childMs,
    gate: { command: "recipe-gate extract " + quote(file), output: "json" },
  };
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
  return {
    key: key,
    agent: "synthesizer",
    task: lines.join("\n"),
    output: out,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
  };
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
  const list = [];
  sources.forEach(function (rec) {
    if (rec.status !== "ok" || rec.round !== round) return;
    rec.files.forEach(function (f) {
      list.push({ file: f.file, bytes: f.bytes, angle: rec.angle });
    });
  });
  return list;
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

function board(stage) {
  if (typeof emit !== "function") return;
  emit({ stage: stage, sources: counts(), gap_round: gapRound, children: children, healed: healed, decide: decide });
}

function receipt(out) {
  board("finished");
  return { output: out, sources: counts(), healed: healed, decide: decide, open: open, gap_round: gapRound, children: children };
}

// A step whose output was not accepted goes to a diagnose child, which picks
// one of the allowed actions; the cap and the signature check keep healing
// from looping. The result is null when a person has to decide.
const subject = { heals: 0, signatures: [], lastDiagnosis: null };

function diagnose(step, signal, evidence, allowed) {
  if (subject.heals >= MAX_HEALS) {
    decide.push({ step: step, question: short(signal + " (still failing after " + MAX_HEALS + " recoveries)"), diagnosis: subject.lastDiagnosis });
    return Promise.resolve(null);
  }
  subject.heals++;
  const file = dir + "/diagnosis-" + subject.heals + ".md";
  let command = "recipe-gate diagnosis " + quote(file) + " --allow " + quote(allowed.join(","));
  if (allowed.indexOf("continue") >= 0) command += " --verdict yes";
  const lines = [
    "Diagnose a step whose output the script did not accept (the diagnosis variant).",
    "Goal: " + goal,
    "Requested output: " + format,
    "Task directory: " + dir,
    "Step: " + STEPS[step],
    "What went wrong: " + short(signal),
  ];
  const shown = evidence.filter(Boolean);
  if (shown.length) lines.push("Evidence: " + shown.join(", "));
  if (subject.lastDiagnosis) lines.push("Earlier diagnosis: " + subject.lastDiagnosis);
  if (allowed.indexOf("continue") >= 0) lines.push("With continue, give the verdict the review states.");
  lines.push("Allowed actions: " + allowed.join(", "));
  lines.push("Write the diagnosis to " + file);
  board("diagnosing " + step);
  return launch([
    {
      key: "diagnose-" + subject.heals,
      agent: "reviewer",
      task: lines.join("\n"),
      output: file,
      outputMode: "file-only",
      maxRuntimeMs: childMs,
      gate: { command: command, output: "json" },
    },
  ]).then(function (results) {
    const result = results[0];
    subject.lastDiagnosis = result.file;
    let problem = null;
    const d = result.structuredOutput;
    if (!result.ok || !d) problem = "the diagnosis failed: " + (result.error || "no result");
    else if (!d.ok) problem = "the diagnosis could not be read: " + d.problem;
    else {
      const signature = step + ":" + d.action + ":" + String(d.reason).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (subject.signatures.indexOf(signature) >= 0) problem = "the same diagnosis came back twice: " + d.reason;
      else subject.signatures.push(signature);
    }
    if (problem) {
      decide.push({ step: step, question: short(signal + "; " + problem), diagnosis: result.file });
      return null;
    }
    if (d.action === "decide") {
      decide.push({ step: step, question: short(d.reason), diagnosis: result.file });
      return null;
    }
    healed.push({ step: step, action: d.action, reason: short(d.reason) });
    return Object.assign({}, d, { file: result.file });
  });
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

function reviewItem(n, file, files) {
  return {
    key: n === 1 ? "review" : "review-" + n,
    agent: "reviewer",
    task: [
      "Review a research deliverable (the research variant).",
      "Goal: " + goal,
      "Requested output: " + format,
      "Deliverable: " + deliverable,
      "Findings it rests on:",
    ]
      .concat(
        files.map(function (f) {
          return "- " + f.file;
        }),
      )
      .concat(["Write the report to " + file])
      .join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    gate: { command: "recipe-gate gaps " + quote(file), output: "json" },
  };
}

const anglesFile = dir + "/angles.md";
const planned = (
  await launch([
    {
      key: "angles",
      agent: "planner",
      task: [
        "Job: angles.",
        "Goal: " + goal,
        "Requested output: " + format,
        "Write at most " + MAX_ANGLES + " angles to " + anglesFile + ", in the angles format.",
      ].join("\n"),
      output: anglesFile,
      outputMode: "file-only",
      maxRuntimeMs: childMs,
      gate: { command: "recipe-gate angles " + quote(anglesFile), output: "json" },
    },
  ])
)[0];

let current;
if (passed(planned)) {
  current = planned.structuredOutput.angles.slice(0, MAX_ANGLES).map(function (a) {
    return { id: slug(a.id), question: a.question };
  });
} else {
  current = [{ id: "main", question: goal }];
  open.push("angles: the planner produced no usable list, so the goal was searched as one angle");
}

let gapAngles = [];

for (let round = 0; round < 2; round++) {
  board(round === 0 ? "searching" : "gap round: searching");
  const limit = round === 0 ? maxSources : Math.min(maxSources, GAP_SOURCES);

  const searches = await launch(
    current.map(function (angle) {
      const file = dir + "/raw/search/search-" + angle.id + ".md";
      return {
        key: "search-" + angle.id,
        agent: "searcher",
        task: ["Goal: " + goal, "Angle: " + angle.id, "Question: " + angle.question, "Output: " + file].join("\n"),
        output: file,
        outputMode: "file-only",
        maxRuntimeMs: childMs,
        gate: { command: "recipe-gate urls " + quote(file), output: "json" },
      };
    }),
  );

  const known = {};
  sources.forEach(function (rec) {
    known[rec.url] = true;
  });
  const found = [];
  searches.forEach(function (s, i) {
    if (!passed(s)) {
      open.push("search " + current[i].id + ": " + (s.ok ? "no sources listed" : s.error || "failed"));
      return;
    }
    s.structuredOutput.urls.forEach(function (u) {
      if (!known[u.url]) found.push({ url: u.url, kind: u.kind, why: u.why, angle: current[i].id });
    });
  });
  const picked = rankAndCap(found, limit);

  const recs = picked.map(function (p, j) {
    return { k: nextK + j, url: p.url, angle: p.angle, round: round, status: "ok", files: [], error: null };
  });
  nextK += recs.length;

  board(round === 0 ? "extracting" : "gap round: extracting");
  const first = recs.length ? await launch(recs.map(function (rec) { return extractItem(rec, "", ""); })) : [];
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
    const second = await launch(halves.map(function (h) { return extractItem(h.rec, h.suffix, h.part); }));
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
      return receipt(null);
    }
    const files = okFiles(0);
    if (files.length === 0) {
      open.push("no extract passed its checks, so nothing was synthesized");
      return receipt(null);
    }

    const bytes = files.reduce(function (sum, f) { return sum + f.bytes; }, 0);
    const est = Math.ceil(bytes / 4);
    const split = est <= 0.5 * windowTokens ? 1 : Math.max(2, Math.ceil(est / SYNTH_TOKENS));

    board("synthesizing");
    deliverable = await synthesize(files, split, "", output);
    if (!deliverable) {
      const d = await diagnose("synthesize", "the synthesizer failed twice", [dir + "/raw/extract"], ["retry", "decide"]);
      if (d) deliverable = await synthesize(files, split, "-2", sibling(output, "2"));
    }
    if (!deliverable) {
      open.push("the synthesizer failed, so there is no output");
      return receipt(null);
    }

    let rg = null;
    let reviewFile = null;
    for (let n = 1; ; n++) {
      board("reviewing");
      reviewFile = n === 1 ? dir + "/review.md" : sibling(dir + "/review.md", String(n));
      const review = (await launch([reviewItem(n, reviewFile, files)]))[0];
      reviewFile = review.file;
      rg = review.ok ? review.structuredOutput : null;
      if (!rg) {
        const d = await diagnose("review", "the reviewer failed: " + (review.error || "its gate did not run"), [review.file], ["retry", "decide"]);
        if (d) continue;
        break;
      }
      if (rg.verdict !== "invalid") break;
      const d = await diagnose("review", "the review's verdict could not be read", [review.file], ["continue", "retry", "decide"]);
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
      gapAngles = (rg.angles || []).slice(0, MAX_ANGLES).map(function (a) {
        return { id: "gap-" + slug(a.id), question: a.question };
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
      const r = (await launch([synthItem("synthesis-update", files.map(function (f) { return f.file; }), sibling(deliverable, "updated"), "update", deliverable)]))[0];
      if (r.ok) deliverable = r.file;
      else open.push("the final update failed; the output is the first synthesis");
    }
  }
}

return receipt(deliverable);
