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
const childMs = args.childTimeoutMs || 1200000;
const bigMs = args.bigTimeoutMs || 2400000;

const sources = [];
const open = [];
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

function receipt(out) {
  const counts = { ok: 0, failed: 0, over_cap: 0 };
  sources.forEach(function (rec) {
    if (rec.status === "ok") counts.ok++;
    else if (rec.status === "over_cap") counts.over_cap++;
    else counts.failed++;
  });
  return { output: out, sources: counts, open: open, gap_round: gapRound, children: children };
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

    if (split === 1) {
      const r = (await launch([synthItem("synthesis", files.map(function (f) { return f.file; }), output, "synthesis")]))[0];
      if (r.ok) deliverable = r.file;
    } else {
      const partials = [];
      const groups = groupFiles(files, split);
      for (let g = 0; g < groups.length; g++) {
        const out = dir + "/synthesis-" + g + ".md";
        const r = (await launch([synthItem("synthesis-" + g, groups[g], out, "partial")]))[0];
        if (r.ok) partials.push(r.file);
        else open.push("partial synthesis " + g + " failed");
      }
      if (partials.length > 0) {
        const r = (await launch([synthItem("synthesis-combine", partials, output, "combine")]))[0];
        if (r.ok) deliverable = r.file;
      }
    }
    if (!deliverable) {
      open.push("the synthesizer failed, so there is no output");
      return receipt(null);
    }

    const reviewFile = dir + "/review.md";
    const review = (
      await launch([
        {
          key: "review",
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
            .concat(["Write the report to " + reviewFile])
            .join("\n"),
          output: reviewFile,
          outputMode: "file-only",
          maxRuntimeMs: bigMs,
          gate: { command: "recipe-gate gaps " + quote(reviewFile), output: "json" },
        },
      ])
    )[0];

    const rg = review.ok ? review.structuredOutput : null;
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
