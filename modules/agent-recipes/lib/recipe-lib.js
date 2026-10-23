// Shared by every recipe graph. Nix prepends this file to a graph to make the
// installed workflow.js, because the workflow sandbox cannot import. Graphs
// reach the harness only through `port`. A harness supplies runMany, runOne
// and emit; the role table in nix supplies each agent's model, tools and
// thinking, and the harness wakes the starting session once with the returned
// receipt.

const MAX_HEALS = 2;
const REASON_CHARS = 300;

const port = {
  runMany: function (items) {
    return runs.all(items);
  },
  runOne: function (item) {
    return port.runMany([item]).then(function (results) {
      return results[0];
    });
  },
  emit: function (value) {
    if (typeof emit === "function") emit(value);
  },
};

const healed = [];
const decide = [];
const tally = { children: 0 };

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function sibling(file, tag) {
  return file.replace(/(\.md)?$/, "." + tag + "$1");
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function slugOf(text) {
  return String(text).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function short(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? flat.slice(0, REASON_CHARS) + "..." : flat;
}

function passed(result) {
  return Boolean(result.ok && result.structuredOutput && result.structuredOutput.ok);
}

// One child of the graph. `lines` is the brief; a gated node is told to run
// its own gate before it reports, unless `opts.selfGate` is false (a gate
// with side effects, such as one that tidies worktrees).
function node(key, agent, lines, output, opts) {
  const o = opts || {};
  const text = lines.slice();
  if (o.gate && o.selfGate !== false) {
    text.push("When the file is written, run `" + o.gate + "`; if it reports a problem, fix the file and run it again before you finish, unless your report says blocked or failed.");
  }
  const item = { key: key };
  if (agent !== undefined) item.agent = agent;
  Object.assign(item, {
    task: text.join("\n"),
    output: output,
    outputMode: "file-only",
  });
  if (o.timeoutMs) item.maxRuntimeMs = o.timeoutMs;
  if (o.gate) {
    item.gate = { command: o.gate, output: "json" };
    if (o.gateTimeoutMs) item.gate.timeoutMs = o.gateTimeoutMs;
  }
  if (o.worktree !== undefined) item.worktree = o.worktree;
  if (o.resume) item.resume = o.resume;
  if (o.big) item.big = true;
  return item;
}

function retryItem(item, failed) {
  const moved = sibling(item.output, "retry");
  const copy = Object.assign({}, item, {
    key: item.key + "-retry",
    output: moved,
    task: item.task.split(item.output).join(moved),
  });
  if (item.resume) copy.resume = failed.runId || item.resume;
  if (item.gate) {
    copy.gate = Object.assign({}, item.gate, {
      command: item.gate.command.split(quote(item.output)).join(quote(moved)),
    });
  }
  return copy;
}

// pi-subagents marks a writer that reports its own work as not done as
// failed; the same brief again gets the same answer, so it is not retried.
function stoppedItself(result) {
  return /reported as not-satisfied/.test(String(result.error || ""));
}

// Runs small items together; a child that failed on its own is run once more
// under a sibling output path. Each result carries the file it wrote as
// `file`.
function launchSmall(items, runFirst) {
  tally.children += items.length;
  return (runFirst || port.runMany)(items).then(function (first) {
    const merged = first.map(function (result, i) {
      return Object.assign({}, result, { file: items[i].output });
    });
    const again = [];
    const where = [];
    first.forEach(function (result, i) {
      if (!result.ok && !stoppedItself(result)) {
        again.push(retryItem(items[i], result));
        where.push(i);
      }
    });
    if (again.length === 0) return merged;
    tally.children += again.length;
    return port.runMany(again).then(function (second) {
      second.forEach(function (result, j) {
        merged[where[j]] = Object.assign({}, result, { file: again[j].output });
      });
      return merged;
    });
  });
}

// A big item gets the engine's window to itself: it runs alone, and so does
// its retry.
function launchBig(item) {
  tally.children++;
  return port.runOne(item).then(function (first) {
    if (first.ok || stoppedItself(first)) return Object.assign({}, first, { file: item.output });
    const again = retryItem(item, first);
    tally.children++;
    return port.runOne(again).then(function (second) {
      return Object.assign({}, second, { file: again.output });
    });
  });
}

// Small items run together first; big items then run one after another, so a
// big node never shares the engine with another big one. Results keep the
// caller's order.
function launch(items, runFirst) {
  if (!items.some(function (item) { return item.big; })) return launchSmall(items, runFirst);
  const small = items.filter(function (item) { return !item.big; });
  const slots = [];
  items.forEach(function (item, i) {
    if (!item.big) slots.push(i);
  });
  const results = new Array(items.length);
  let chain = (small.length ? launchSmall(small, runFirst) : Promise.resolve([])).then(function (done) {
    done.forEach(function (result, j) {
      results[slots[j]] = result;
    });
  });
  items.forEach(function (item, i) {
    if (!item.big) return;
    chain = chain.then(function () {
      return launchBig(item).then(function (result) {
        results[i] = result;
      });
    });
  });
  return chain.then(function () {
    return results;
  });
}

function one(item) {
  if (item.big) {
    return launch([item]).then(function (results) {
      return results[0];
    });
  }
  return launchSmall([item], function (items) {
    return port.runOne(items[0]).then(function (result) {
      return [result];
    });
  }).then(function (results) {
    return results[0];
  });
}

// Diagnosis: a step whose output was not accepted goes to a fresh reviewer,
// which picks one allowed action. A subject (the whole run, or one task) gets
// at most MAX_HEALS diagnoses, and the same diagnosis twice counts as decide.
function subjectOf(id) {
  return { id: id, heals: 0, signatures: [], lastDiagnosis: null, trouble: null };
}

function troubleOf(step, signal, evidence, allowed) {
  return { step: step, signal: short(signal), evidence: evidence.filter(Boolean), allowed: allowed };
}

function exhausted(subject) {
  return subject.heals >= MAX_HEALS;
}

function exhaustedQuestion(trouble) {
  return trouble.signal + " (still failing after " + MAX_HEALS + " recoveries)";
}

function askDecision(subject, step, question, file) {
  decide.push({ id: subject.id, step: step, question: short(question), diagnosis: file || null });
}

function diagnosisItem(subject, trouble, dir, context, stepText, childMs) {
  subject.heals++;
  const file = dir + "/diagnosis-" + (subject.id ? subject.id + "-" : "") + subject.heals + ".md";
  let command = "recipe-gate diagnosis " + quote(file) + " --allow " + quote(trouble.allowed.join(","));
  const verdictWanted = trouble.allowed.indexOf("continue") >= 0;
  if (verdictWanted) command += " --verdict yes";
  const lines = ["Diagnose a step whose output the script did not accept (the diagnosis variant)."].concat(context);
  lines.push("Step: " + stepText);
  lines.push("What went wrong: " + trouble.signal);
  if (trouble.evidence.length) lines.push("Evidence: " + trouble.evidence.join(", "));
  if (subject.lastDiagnosis) lines.push("Earlier diagnosis: " + subject.lastDiagnosis);
  if (verdictWanted) lines.push("With continue, give the verdict the review states.");
  lines.push("Allowed actions: " + trouble.allowed.join(", "));
  lines.push("Write the diagnosis to " + file);
  return node("diagnose-" + (subject.id ? subject.id + "-" : "") + subject.heals, "reviewer", lines, file, { gate: command, timeoutMs: childMs });
}

// Returns the diagnosis with its file, or null after recording a decision.
function readDiagnosis(subject, trouble, result) {
  subject.lastDiagnosis = result.file;
  const d = result.structuredOutput;
  let problem = null;
  if (!result.ok || !d) problem = "the diagnosis failed: " + (result.error || "no result");
  else if (!d.ok) problem = "the diagnosis could not be read: " + d.problem;
  else {
    const signature = trouble.step + ":" + d.action + ":" + String(d.reason).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (subject.signatures.indexOf(signature) >= 0) problem = "the same diagnosis came back twice: " + d.reason;
    else subject.signatures.push(signature);
  }
  if (problem) {
    askDecision(subject, trouble.step, trouble.signal + "; " + problem, result.file);
    return null;
  }
  if (d.action === "decide") {
    askDecision(subject, trouble.step, d.reason, result.file);
    return null;
  }
  healed.push({ id: subject.id, step: trouble.step, action: d.action, reason: short(d.reason) });
  return Object.assign({}, d, { file: result.file });
}

function diagnose(subject, trouble, dir, context, stepText, childMs) {
  if (exhausted(subject)) {
    askDecision(subject, trouble.step, exhaustedQuestion(trouble), subject.lastDiagnosis);
    return Promise.resolve(null);
  }
  return one(diagnosisItem(subject, trouble, dir, context, stepText, childMs)).then(function (result) {
    return readDiagnosis(subject, trouble, result);
  });
}

// Gather nodes: a searcher lists sources for one question, an extractor
// copies the passages of one source. Any graph may use them.
function searchItem(goal, angle, file, childMs) {
  return node(
    "search-" + angle.id,
    "searcher",
    ["Goal: " + goal, "Angle: " + angle.id, "Question: " + angle.question, "Output: " + file],
    file,
    { gate: "recipe-gate urls " + quote(file), timeoutMs: childMs },
  );
}

function extractItem(key, goal, url, angle, page, file, part, childMs) {
  const lines = ["Goal: " + goal, "URL: " + url, "Angle: " + angle, "Page: " + page, "Output: " + file];
  if (part) lines.push(part);
  return node(key, "extractor", lines, file, { gate: "recipe-gate extract " + quote(file), timeoutMs: childMs });
}

// Repository variants: a locator lists files and line ranges for one
// question, a file extractor copies the passages of one file.
function locateItem(goal, angle, repo, file, childMs) {
  return node(
    "locate-" + angle.id,
    "locator",
    ["Goal: " + goal, "Angle: " + angle.id, "Question: " + angle.question, "Repository: " + repo, "Output: " + file],
    file,
    { gate: "recipe-gate paths " + quote(file), timeoutMs: childMs },
  );
}

function extractFileItem(key, goal, path, range, angle, file, childMs) {
  const lines = ["Goal: " + goal, "File: " + path];
  if (range) lines.push("Range: " + range.start + "-" + range.end);
  lines.push("Angle: " + angle, "Output: " + file);
  return node(key, "extractor", lines, file, { gate: "recipe-gate extract " + quote(file), timeoutMs: childMs });
}

// Keeps each angle's primary sources first, takes one source per angle in
// turn, drops repeats and stops at the limit.
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
    const l = byAngle[order[i]];
    byAngle[order[i]] = l.filter((u) => u.kind === "primary").concat(l.filter((u) => u.kind !== "primary"));
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

// Lists the sources the searches found that are not already known.
function sourcesFound(angles, searches, known, open) {
  const found = [];
  searches.forEach(function (s, i) {
    if (!passed(s)) {
      open.push("search " + angles[i].id + ": " + (s.ok ? "no sources listed" : s.error || "failed"));
      return;
    }
    s.structuredOutput.urls.forEach(function (u) {
      if (!known[u.url]) found.push({ url: u.url, kind: u.kind, why: u.why, angle: angles[i].id });
    });
  });
  return found;
}

// Lists the files the locators found that are not already known. The url
// field is the repository-relative path, with ":start-end" when ranged, so
// rankAndCap treats a file like a page.
function pathsFound(angles, results, known, open) {
  const found = [];
  results.forEach(function (s, i) {
    if (!passed(s)) {
      open.push("locate " + angles[i].id + ": " + (s.ok ? "no files listed" : s.error || "failed"));
      return;
    }
    s.structuredOutput.paths.forEach(function (p) {
      const range = p.range || null;
      const url = p.path + (range ? ":" + range.start + "-" + range.end : "");
      if (!known[url]) found.push({ url: url, path: p.path, range: range, kind: p.kind, why: p.why, angle: angles[i].id });
    });
  });
  return found;
}

// What a person watching the run sees: the graph's own view of its progress
// plus the counters every graph shares.
function board(stage, view) {
  port.emit(Object.assign({ stage: stage }, view, { children: tally.children, healed: healed, decide: decide }));
}

function receipt(fields) {
  board("finished", fields);
  return Object.assign({}, fields, { healed: healed, decide: decide, children: tally.children });
}

// One research question run through a searcher and/or a locator, ranked and
// capped, then extracted. Resolves { files, sources, open }.
function gatherSources(spec) {
  const source = spec.source || "web";
  const limit = spec.limit || 3;
  const open = [];
  const none = { files: [], sources: [], open: open };
  if (source !== "web" && source !== "repo" && source !== "both") {
    open.push("source must be web, repo or both");
    return Promise.resolve(none);
  }
  if (source !== "web" && !spec.repo) {
    open.push("a repository source needs the repo argument");
    return Promise.resolve(none);
  }
  const base = spec.dir + "/research/" + spec.id;
  const angles = [{ id: spec.id, question: spec.question }];
  const items = [];
  if (source !== "repo") items.push(searchItem(spec.goal, angles[0], base + "/search.md", spec.childMs));
  if (source !== "web") items.push(locateItem(spec.goal, angles[0], spec.repo, base + "/locate.md", spec.childMs));
  return launch(items).then(function (results) {
    const searches = source === "repo" ? [] : results.slice(0, 1);
    const locates = source === "web" ? [] : results.slice(results.length - 1);
    const found = (searches.length ? sourcesFound(angles, searches, {}, open) : []).concat(
      locates.length ? pathsFound(angles, locates, {}, open) : [],
    );
    const picked = rankAndCap(found, limit);
    if (picked.length === 0) {
      open.push("no sources were found");
      return none;
    }
    const files = picked.map(function (p, j) {
      return base + "/extract-" + (j + 1) + ".md";
    });
    const extracts = picked.map(function (p, j) {
      const key = "extract-" + spec.id + "-" + (j + 1);
      if (p.path) return extractFileItem(key, spec.question, spec.repo + "/" + p.path, p.range, spec.id, files[j], spec.childMs);
      return extractItem(key, spec.question, p.url, spec.id, base + "/page-" + (j + 1) + ".md", files[j], "", spec.childMs);
    });
    return launch(extracts).then(function (done) {
      const sources = [];
      const good = [];
      picked.forEach(function (p, j) {
        const r = done[j];
        const g = r.structuredOutput || {};
        let status = "ok";
        if (!r.ok) status = "failed";
        else if (g.over_cap) status = "over_cap";
        else if (!passed(r)) status = "rejected";
        sources.push({ url: p.url, status: status });
        if (status === "ok") good.push(files[j]);
        else open.push("source " + p.url + ": " + status);
      });
      return { files: good, sources: sources, open: open };
    });
  });
}
