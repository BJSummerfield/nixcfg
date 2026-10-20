const MAX_REVISIONS = 2;
const MAX_HEALS = 2;
const REASON_CHARS = 300;

const dir = args.dir;
const goal = args.goal;
const input = args.input;
const repo = args.repo;
const childMs = args.childTimeoutMs || 1200000;
const bigMs = args.bigTimeoutMs || 2400000;

const STEPS = {
  plan: "the planner's run (plan.md, the task files and the plan check)",
  review: "the review of the plan",
};

const open = [];
const healed = [];
const decide = [];
let children = 0;
let last = null;
let reviewVerdict = null;
let stage = "scouting";

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
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

function one(item) {
  return launch([item]).then(function (results) {
    return results[0];
  });
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function board(next) {
  stage = next;
  if (typeof emit !== "function") return;
  emit({
    stage: stage,
    tasks: last ? list(last.tasks).length : 0,
    plan_ok: last ? Boolean(last.ok) : null,
    review: reviewVerdict,
    healed: healed,
    decide: decide,
  });
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

function gateProblem(result, what) {
  if (!result.ok) return what + " failed: " + (result.error || "failed");
  if (!result.structuredOutput) return what + ": the plan check did not run";
  last = result.structuredOutput;
  return null;
}

function problems(g) {
  const out = [];
  if (list(g.oversize).length) out.push("oversize: " + g.oversize.join(", "));
  list(g.overlaps).forEach(function (o) {
    out.push("overlap: " + o[0] + " and " + o[1] + " both own " + o[2]);
  });
  list(g.cycles).forEach(function (c) {
    out.push("cycle: " + c.join(" > "));
  });
  list(g.missing).forEach(function (m) {
    out.push("missing: " + m);
  });
  return out;
}

function receipt() {
  board("finished");
  return {
    plan_dir: dir,
    tasks: last ? list(last.tasks).length : 0,
    oversize: last ? list(last.oversize) : [],
    overlaps: last ? list(last.overlaps) : [],
    review: reviewVerdict,
    healed: healed,
    decide: decide,
    open: open,
    children: children,
  };
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
    "Input: " + input,
    "Repository: " + repo,
    "Plan directory: " + dir,
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
  return one({
    key: "diagnose-" + subject.heals,
    agent: "reviewer",
    task: lines.join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: childMs,
    gate: { command: command, output: "json" },
  }).then(function (result) {
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

function fromDiagnosis(d) {
  return "The diagnosis at " + d.file + " found: " + d.reason + " Follow its ## Brief section.";
}

let reviews = 0;

function reviewItem() {
  reviews++;
  const file = reviews === 1 ? dir + "/review.md" : sibling(dir + "/review.md", String(reviews));
  return {
    key: reviews === 1 ? "review" : "review-" + reviews,
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

// Resolves to { verdict, file }, with verdict null when no review could be had.
function review() {
  board("reviewing");
  return one(reviewItem()).then(function (result) {
    if (!result.ok || !result.structuredOutput) {
      return diagnose("review", "the reviewer failed: " + (result.error || "its verdict gate did not run"), [result.file], ["retry", "decide"]).then(function (d) {
        return d ? review() : { verdict: null, file: result.file };
      });
    }
    const verdict = result.structuredOutput.verdict;
    if (verdict !== "invalid") return { verdict: verdict, file: result.file };
    return diagnose("review", "the review's verdict could not be read", [result.file], ["continue", "retry", "decide"]).then(function (d) {
      if (!d) return { verdict: null, file: result.file };
      if (d.action === "retry") return review();
      return { verdict: d.verdict, file: result.file };
    });
  });
}

let revisions = 0;

function revise(job, extra) {
  revisions++;
  board("revising");
  return one(plannerItem("revise-" + revisions, dir + "/revision-" + revisions + ".md", brief(" (revision " + revisions + job + ")", ["Revise the files in place."].concat(extra))));
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

board("planning");
const closing = "Closing note: one line per task, then anything you guessed.";
let planned = await one(plannerItem("plan", dir + "/planner.md", brief("", [closing])));
let problem = gateProblem(planned, "the planner");
if (problem) {
  const d = await diagnose("plan", problem, [planned.file, scoutFile], ["retry", "decide"]);
  if (d) {
    board("planning");
    planned = await one(plannerItem("plan-2", dir + "/planner-2.md", brief("", [closing, "An earlier attempt did not finish. " + fromDiagnosis(d)])));
    problem = gateProblem(planned, "the planner");
  }
  if (problem) {
    open.push(problem);
    return receipt();
  }
}

let lastPlanFile = planned.file;
while (!last.ok && !onlyNoTasks(last) && revisions < MAX_REVISIONS) {
  const revised = await revise("", findingLines(last));
  problem = gateProblem(revised, "revision " + revisions);
  if (problem) {
    open.push(problem);
    break;
  }
  lastPlanFile = revised.file;
}

if (!last.ok && !onlyNoTasks(last) && !problem) {
  const d = await diagnose(
    "plan",
    "the plan check still fails after " + revisions + " revisions: " + problems(last).join("; "),
    [dir + "/plan.md", lastPlanFile],
    ["fix", "decide"],
  );
  if (d) {
    const revised = await revise(", from a diagnosis", [fromDiagnosis(d)].concat(findingLines(last)));
    problem = gateProblem(revised, "revision " + revisions);
    if (problem) open.push(problem);
  }
}

let verdict = await review();
reviewVerdict = verdict.verdict;

if (reviewVerdict === "needs-work") {
  const fixed = await revise(" after review", ["Address the blocking findings of the review at " + verdict.file + "; leave small findings."]);
  problem = gateProblem(fixed, "the revision after review");
  if (problem) open.push(problem);
  else if (last.ok) {
    verdict = await review();
    reviewVerdict = verdict.verdict;
    if (reviewVerdict === "needs-work") {
      const d = await diagnose("plan", "the plan still needs work after a revision for its review", [verdict.file, dir + "/plan.md"], ["fix", "decide"]);
      if (d) {
        const again = await revise(", from a diagnosis", [fromDiagnosis(d), "The latest review is " + verdict.file + "."]);
        problem = gateProblem(again, "revision " + revisions);
        if (problem) open.push(problem);
        else if (last.ok) {
          verdict = await review();
          reviewVerdict = verdict.verdict;
        }
      }
    }
  }
}

if (reviewVerdict !== "clean") {
  open.push(reviewVerdict === null ? "no review verdict; see " + verdict.file : "review verdict " + reviewVerdict + "; see " + verdict.file);
}

if (!last.ok) {
  problems(last).forEach(function (p) {
    open.push(p);
  });
}

return receipt();
