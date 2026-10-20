const MAX_REVISIONS = 2;

const dir = args.dir;
const goal = args.goal;
const input = args.input;
const repo = args.repo;
const childMs = args.childTimeoutMs || 1200000;
const bigMs = args.bigTimeoutMs || 2400000;

const open = [];
let children = 0;
let last = null;
let reviewVerdict = null;

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
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

function one(item) {
  return launch([item]).then(function (results) {
    return results[0];
  });
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function planGateCommand() {
  let command = "recipe-gate plan " + quote(dir) + " --repo " + quote(repo);
  if (args.limit) command += " --limit " + Number(args.limit);
  if (args.sizing) command += " --sizing " + quote(args.sizing);
  return command;
}

function brief(job, extra) {
  return [
    "Job: implementation plan" + job + ".",
    "Goal: " + goal,
    "Input: " + input,
    "Repository: " + repo,
    "Scout notes: " + scoutNotes,
    "Plan directory: " + dir,
    "Write " + dir + "/plan.md and one " + dir + "/tasks/<id>.md per task in the task header format; delete any file in " + dir + "/tasks/ that no longer belongs.",
  ].concat(extra);
}

function plannerItem(key, output, lines) {
  return {
    key: key,
    agent: "planner",
    task: lines.join("\n"),
    output: output,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    gate: { command: planGateCommand(), output: "json" },
  };
}

function findingLines(g) {
  const lines = ["The plan check reported:"];
  const names = list(g.tasks).filter(function (t) {
    return list(g.oversize).indexOf(t.id) >= 0;
  });
  names.forEach(function (t) {
    lines.push("- oversize: " + t.id + " (estimate " + t.est + "): split it along its owned files, each part with its own check");
  });
  list(g.overlaps).forEach(function (o) {
    lines.push("- overlap: " + o[0] + " and " + o[1] + " both own " + o[2] + ": give the file to one task");
  });
  list(g.cycles).forEach(function (c) {
    lines.push("- cycle: " + c.join(" > ") + ": break the loop");
  });
  list(g.missing).forEach(function (m) {
    lines.push("- missing: " + m);
  });
  lines.push("Check output: " + JSON.stringify({ oversize: g.oversize, overlaps: g.overlaps, missing: g.missing, cycles: g.cycles }));
  return lines;
}

function onlyNoTasks(g) {
  return (
    list(g.missing).length === 1 &&
    g.missing[0] === "no tasks" &&
    list(g.oversize).length === 0 &&
    list(g.overlaps).length === 0 &&
    list(g.cycles).length === 0
  );
}

function takeGate(result, what) {
  if (!result.ok) {
    open.push(what + " failed: " + (result.error || "failed"));
    return false;
  }
  if (!result.structuredOutput) {
    open.push(what + ": the plan check did not run");
    return false;
  }
  last = result.structuredOutput;
  return true;
}

function remaining(g) {
  if (list(g.oversize).length) open.push("oversize: " + g.oversize.join(", "));
  list(g.overlaps).forEach(function (o) {
    open.push("overlap: " + o[0] + " and " + o[1] + " both own " + o[2]);
  });
  list(g.cycles).forEach(function (c) {
    open.push("cycle: " + c.join(" > "));
  });
  list(g.missing).forEach(function (m) {
    open.push("missing: " + m);
  });
}

function receipt() {
  return {
    plan_dir: dir,
    tasks: last ? list(last.tasks).length : 0,
    oversize: last ? list(last.oversize) : [],
    overlaps: last ? list(last.overlaps) : [],
    review: reviewVerdict,
    open: open,
    children: children,
  };
}

function reviewItem(key, file) {
  return {
    key: key,
    agent: "reviewer",
    task: [
      "Review an implementation plan (the plan variant).",
      "Goal: " + goal,
      "Input: " + input,
      "Repository: " + repo,
      "Scout notes: " + scoutNotes,
      "Plan: " + dir + "/plan.md and " + dir + "/tasks/",
      "Plan check to run: " + planGateCommand(),
      "Write the report to " + file,
    ].join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    gate: { command: "recipe-gate verdict " + quote(file), output: "json" },
  };
}

function reviewed(result) {
  if (!result.ok || !result.structuredOutput) {
    open.push("the review failed or its gate did not run");
    reviewVerdict = null;
    return null;
  }
  reviewVerdict = result.structuredOutput.verdict;
  return result;
}

const scoutFile = dir + "/scout.md";
const scouted = await one({
  key: "scout",
  agent: "scout",
  task: [
    "Goal: " + goal,
    "Input: " + input + " (read it first)",
    "Repository: " + repo,
    "Find what a planner needs to split this work into tasks: the files involved and their sizes, how they relate, the repository's AGENTS.md light checks, heavy checks and forbidden changes, and the exact command for a light check on each kind of file involved.",
    "Output: " + scoutFile,
  ].join("\n"),
  output: scoutFile,
  outputMode: "file-only",
  maxRuntimeMs: childMs,
});
let scoutNotes = "none: the scout failed, so look up the facts yourself";
if (scouted.ok) scoutNotes = scouted.file;
else open.push("scout failed: " + (scouted.error || "failed") + "; the planner worked without notes");

const planned = await one(plannerItem("plan", dir + "/planner.md", brief("", ["Closing note: one line per task, then anything you guessed."])));

if (!takeGate(planned, "the planner")) return receipt();

let revisions = 0;
while (!last.ok && !onlyNoTasks(last) && revisions < MAX_REVISIONS) {
  revisions++;
  const revised = await one(
    plannerItem("revise-" + revisions, dir + "/revision-" + revisions + ".md", brief(" (revision " + revisions + ")", ["Revise the files in place."].concat(findingLines(last)))),
  );
  if (!takeGate(revised, "revision " + revisions)) break;
}

const reviewFile = dir + "/review.md";
let verdict = reviewed(await one(reviewItem("review", reviewFile)));

if (verdict && reviewVerdict === "needs-work") {
  const fixed = await one(
    plannerItem(
      "revise-review",
      dir + "/revision-review.md",
      brief(" (revision after review)", ["Revise the files in place. Address the blocking findings of the review at " + verdict.file + "; leave small findings."]),
    ),
  );
  if (takeGate(fixed, "the revision after review") && last.ok) {
    verdict = reviewed(await one(reviewItem("review-2", sibling(reviewFile, "2"))));
  }
}

if (verdict && reviewVerdict !== "clean") {
  open.push("review verdict " + reviewVerdict + "; see " + verdict.file);
}

if (!last.ok) remaining(last);

return receipt();
