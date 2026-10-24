// Shared by every recipe graph. Graphs reach the harness only through
// `port`: the runner supplies runMany, runOne and emit; the role table in nix
// supplies each agent's model, tools and thinking. Healing and tally state is
// per call, so one process can run several graphs.

const MAX_HEALS = 2;
const REASON_CHARS = 300;
const HANDOFF_LIMITS = Object.freeze({ MAX_RELAYS: 2, MAX_SPLITS: 2, START_FRACTION: 0.5 });
const UNREAD_ROLES = ["reviewer", "synthesizer"];

export function recipeLib(port) {
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

  function selfGateLine(gate) {
    return "When the file is written, run `" + gate + "`; if it reports a problem, fix the file and run it again before you finish, unless your report says blocked or failed.";
  }

  // One child of the graph. `lines` is the brief; a gated node is told to run
  // its own gate before it reports, unless `opts.selfGate` is false (a gate
  // with side effects, such as one that tidies worktrees).
  function node(key, agent, lines, output, opts) {
    const o = opts || {};
    const text = lines.slice();
    if (o.gate && o.selfGate !== false) text.push(selfGateLine(o.gate));
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

  // The runner marks a writer that reports its own work as not done as failed;
  // the same brief again gets the same answer, so it is not retried.
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
      const finals = items.slice();
      const again = [];
      const where = [];
      first.forEach(function (result, i) {
        if (!result.ok && !stoppedItself(result)) {
          again.push(retryItem(items[i], result));
          where.push(i);
        }
      });
      const finish = function () {
        return Promise.all(
          merged.map(function (result, i) {
            return unreadStep(finals[i], result);
          }),
        );
      };
      if (again.length === 0) return finish();
      tally.children += again.length;
      return port.runMany(again).then(function (second) {
        second.forEach(function (result, j) {
          merged[where[j]] = Object.assign({}, result, { file: again[j].output });
          finals[where[j]] = again[j];
        });
        return finish();
      });
    });
  }

  // A big item gets the engine's window to itself: it runs alone, and so does
  // its retry.
  function launchBig(item) {
    tally.children++;
    return port.runOne(item).then(function (first) {
      if (first.ok || stoppedItself(first)) return unreadStep(item, Object.assign({}, first, { file: item.output }));
      const again = retryItem(item, first);
      tally.children++;
      return port.runOne(again).then(function (second) {
        return unreadStep(again, Object.assign({}, second, { file: again.output }));
      });
    });
  }

  // Runs each step after the previous one settles. The chain starts at the
  // first step's own promise, so the first launch starts as soon as inTurn is
  // called.
  function inTurn(steps) {
    return steps.reduce(function (chain, step) {
      return chain ? chain.then(step) : step();
    }, null) || Promise.resolve();
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
    const steps = [];
    if (small.length) {
      steps.push(function () {
        return launchSmall(small, runFirst).then(function (done) {
          done.forEach(function (result, j) {
            results[slots[j]] = result;
          });
        });
      });
    }
    items.forEach(function (item, i) {
      if (!item.big) return;
      steps.push(function () {
        return launchBig(item).then(function (result) {
          results[i] = result;
        });
      });
    });
    return inTurn(steps).then(function () {
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

  // Handoffs. A child that reached its context budget ends with a reply whose
  // first line is "handoff: ..."; these helpers decide what follows it.
  function handedOff(result) {
    return (result && result.handoff) || null;
  }

  function remainderOf(handoff, head) {
    const line = String((handoff && handoff.line) || "").replace(/^\s*handoff\s*:/i, "");
    const text = handoff && handoff.empty && head ? line + " " + head : line;
    return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  // A piece shares its parent's `root`, so splits count once per original task.
  function handoffTrack(parentTrack) {
    return {
      relays: 0,
      heads: [],
      remainders: [],
      piece: Boolean(parentTrack),
      root: parentTrack ? parentTrack.root : { splits: 0 },
    };
  }

  function afterHandoff(track, info) {
    const limits = HANDOFF_LIMITS;
    const head = info.head || null;
    const remainder = info.remainder || "";
    const lastHead = track.heads.length ? track.heads[track.heads.length - 1] : null;
    const repeated = remainder !== "" && track.remainders.indexOf(remainder) >= 0;
    if (head) track.heads.push(head);
    if (remainder) track.remainders.push(remainder);
    if (repeated) return { action: "decide", reason: "the same remainder came back" };
    if (track.piece && info.commits === 0) return { action: "decide", reason: "nothing committed after a split" };
    let reason = null;
    if (track.relays >= limits.MAX_RELAYS) reason = "relayed " + track.relays + " times already";
    else if (track.relays >= 1 && head && head === lastHead) reason = "the relay committed nothing";
    else if (track.relays >= 1 && info.firstContext > 0 && info.budgetTokens > 0 && info.firstContext > limits.START_FRACTION * info.budgetTokens) {
      reason = "the relay spent over half its budget loading context";
    }
    if (reason === null) return { action: "relay", reason: "first handoff of this task" };
    if (track.root.splits >= limits.MAX_SPLITS) return { action: "decide", reason: "split twice already; " + reason };
    return { action: "split", reason: reason };
  }

  function relayLines(note, branch) {
    const held = "the branch " + branch + " holds the committed work, so build on it and do not redo it.";
    if (note) return ["Continue this task from the handoff note at " + note + "; " + held];
    return ["Continue this task; " + held];
  }

  function splitPlanItem(o) {
    const file = o.splitDir + "/planner.md";
    let gate = "recipe-gate plan " + quote(o.splitDir) + " --repo " + quote(o.worktree);
    if (o.limit) gate += " --limit " + Number(o.limit);
    if (o.sizing) gate += " --sizing " + quote(o.sizing);
    const lines = ["Split a task that its implementer could not finish within one context (the plan variant).", "Task file: " + o.taskFile];
    if (o.note) lines.push("Handoff note: " + o.note);
    lines.push(
      "Branch: " + o.branch,
      "Worktree: " + o.worktree + " (read only; change nothing there)",
      "Work so far: git diff " + o.base + ".." + o.branch,
      "Files the pieces may own: " + (o.owns && o.owns.length ? o.owns.join(", ") : "any file the task needs"),
      "Piece ids start with " + o.parentId + "-.",
      "Plan two or more pieces, each smaller than the task, independent of each other (depends: none), each starting from the branch " + o.branch + "; work already committed there is not redone.",
      "Plan directory: " + o.splitDir,
      "Write " + o.splitDir + "/plan.md and one " + o.splitDir + "/tasks/<id>.md per piece in the task header format.",
      "Write a short summary of the split to " + file,
    );
    const item = node(o.key, "planner", lines, file, { gate: gate, timeoutMs: o.timeoutMs, big: true });
    if (o.handoffOf) item.handoffOf = o.handoffOf;
    item.handoffAs = "split";
    return item;
  }

  function insidePaths(paths, parents) {
    return paths.every(function (p) {
      return parents.some(function (q) {
        return p === q || p.startsWith(q + "/");
      });
    });
  }

  function piecesFrom(gate, o) {
    const prefix = o.parentId + "-";
    const taken = Array.from(o.taken || []);
    const refuse = function (problem) {
      return { ok: false, pieces: [], problem: problem };
    };
    if (!gate || !gate.ok) return refuse("the split plan did not pass the plan gate");
    const tasks = list(gate.tasks);
    if (tasks.length < 2) return refuse("the split plan has fewer than two pieces");
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!String(t.id).startsWith(prefix)) return refuse("piece " + t.id + " does not start with " + prefix);
      if (taken.indexOf(t.id) >= 0) return refuse("piece id " + t.id + " is already taken");
      if (list(t.depends).length) return refuse("piece " + t.id + " depends on " + list(t.depends).join(", ") + "; pieces must be independent");
      if (o.parentOwns && !insidePaths(list(t.owns), o.parentOwns)) return refuse("piece " + t.id + " owns files outside the task's own");
      if (Number.isFinite(o.parentEst) && !(t.est < o.parentEst)) return refuse("piece " + t.id + " is not estimated smaller than the task");
    }
    return { ok: true, pieces: tasks, problem: null };
  }

  function failedStep(item, result, error) {
    return { ok: false, error: error, runId: result.runId, file: result.file || item.output };
  }

  // A reviewer or synthesizer that handed off is continued over the input it
  // did not read; any other role's handoff is the graph's to act on.
  function unreadStep(item, result) {
    if (!result.ok || !result.handoff || UNREAD_ROLES.indexOf(item.agent) < 0) return Promise.resolve(result);
    if (item.merging) return Promise.resolve(failedStep(item, result, "the merge handed off"));
    const unread = list(result.handoff.unread);
    if (unread.length === 0) return Promise.resolve(failedStep(item, result, "handed off without listing unread input"));
    if (item.splitDepth) {
      if (item.splitDepth >= HANDOFF_LIMITS.MAX_SPLITS) return Promise.resolve(failedStep(item, result, "a part handed off at the split limit"));
      if (unread.length >= item.unreadGiven) return Promise.resolve(failedStep(item, result, "a part handed off again without reading any of its input"));
    }
    return continueUnread(item, result);
  }

  // A copy of the item writing to `output` with `task` as its brief; the gate
  // command follows the output like a retry's does.
  function withOutput(item, output, task) {
    const copy = Object.assign({}, item, { output: output, task: task });
    delete copy.resume;
    if (item.gate) {
      copy.gate = Object.assign({}, item.gate, {
        command: item.gate.command.split(quote(item.output)).join(quote(output)),
      });
    }
    return copy;
  }

  // A part of a part is cut from the original brief, not from the earlier
  // part's brief, so only the newest list of inputs is in it.
  function partItem(item, note, k, paths, handoffOf) {
    const base = item.unreadBase || { task: item.task, output: item.output };
    const moved = sibling(item.output, "part-" + k);
    const lines = [
      base.task.split(base.output).join(moved),
      "This continues an earlier " + item.agent + " that handed off" + (note ? "; its notes are at " + note : " before writing notes") + ". Read only these inputs, which it did not reach: " + paths.join(", "),
    ];
    return Object.assign(withOutput(item, moved, lines.join("\n")), {
      key: item.key + "-part-" + k,
      handoffOf: handoffOf,
      handoffAs: "split",
      splitDepth: (item.splitDepth || 0) + 1,
      unreadGiven: paths.length,
      unreadBase: { task: base.task, output: base.output },
    });
  }

  function mergeItem(item, note, files, handoffOf) {
    const merged = sibling(item.output, "merged");
    const text = [
      "Merge the partial results of earlier " + item.agent + " runs. Read only " + (note ? "the handoff note " + note + " and " : "") + "these part files: " + files.join(", ") + "; do not open the original inputs.",
      "Write the whole result, in the format of those files, to " + merged + ".",
    ];
    const selfGated = item.gate && item.task.indexOf("run `" + item.gate.command + "`") >= 0;
    if (selfGated) text.push(selfGateLine(item.gate.command.split(quote(item.output)).join(quote(merged))));
    const copy = withOutput(item, merged, text.join("\n"));
    delete copy.unreadBase;
    delete copy.unreadGiven;
    return Object.assign(copy, {
      key: item.key + "-merge",
      handoffOf: handoffOf,
      handoffAs: "split",
      splitDepth: HANDOFF_LIMITS.MAX_SPLITS,
      merging: true,
    });
  }

  // Runs parts over the unread input (two halves; one part for a single
  // path), then one merge of the same role over the notes and part files.
  // Resolves the merge result, or a failed result when a part or the merge
  // cannot be completed.
  function continueUnread(item, result) {
    const unread = list(result.handoff && result.handoff.unread);
    const note = (result.handoff && result.handoff.note) || null;
    const cut = Math.ceil(unread.length / 2);
    const groups = unread.length > 1 ? [unread.slice(0, cut), unread.slice(cut)] : [unread];
    const parts = groups.map(function (paths, i) {
      return partItem(item, note, i + 1, paths, result.runId);
    });
    return launch(parts).then(function (done) {
      for (let i = 0; i < done.length; i++) {
        if (!done[i].ok) return failedStep(item, result, "part " + parts[i].key + " failed: " + (done[i].error || "no result"));
      }
      const files = done.map(function (r) {
        return r.file;
      });
      return launch([mergeItem(item, note, files, result.runId)]).then(function (results) {
        return results[0];
      });
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

  return {
    port,
    healed,
    decide,
    tally,
    quote,
    sibling,
    list,
    slugOf,
    short,
    passed,
    node,
    retryItem,
    stoppedItself,
    launchSmall,
    launchBig,
    inTurn,
    launch,
    one,
    handoffLimits: HANDOFF_LIMITS,
    handedOff,
    remainderOf,
    handoffTrack,
    afterHandoff,
    relayLines,
    splitPlanItem,
    piecesFrom,
    continueUnread,
    subjectOf,
    troubleOf,
    exhausted,
    exhaustedQuestion,
    askDecision,
    diagnosisItem,
    readDiagnosis,
    diagnose,
    searchItem,
    extractItem,
    locateItem,
    extractFileItem,
    rankAndCap,
    sourcesFound,
    pathsFound,
    board,
    receipt,
    gatherSources,
  };
}
