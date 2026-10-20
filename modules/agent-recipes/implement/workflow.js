const MAX_FIXES = 2;
const REASON_CHARS = 300;

const dir = args.plan;
const repo = args.repo;
const model = args.model;
const childMs = args.childTimeoutMs || 1200000;
const bigMs = args.bigTimeoutMs || 3600000;
const slug = String(dir).replace(/\/+$/, "").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "-") || "plan";
const integrationBranch = args.branch || "implement/" + slug;

const open = [];
const setAside = [];
const skipped = [];
let children = 0;

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function sibling(file, tag) {
  return file.replace(/(\.md)?$/, "." + tag + "$1");
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function short(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? flat.slice(0, REASON_CHARS) + "..." : flat;
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
        again.push(retryItem(items[i], result));
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

function planGateCommand() {
  let command = "recipe-gate plan " + quote(dir) + " --repo " + quote(repo);
  if (args.limit) command += " --limit " + Number(args.limit);
  if (args.sizing) command += " --sizing " + quote(args.sizing);
  return command;
}

function planProblems(g) {
  const problems = [];
  if (list(g.oversize).length) problems.push("oversize: " + g.oversize.join(", "));
  list(g.overlaps).forEach(function (o) {
    problems.push("overlap: " + o[0] + " and " + o[1] + " both own " + o[2]);
  });
  list(g.cycles).forEach(function (c) {
    problems.push("cycle: " + c.join(" > "));
  });
  list(g.missing).forEach(function (m) {
    problems.push("missing: " + m);
  });
  return problems;
}

let branch = null;
let merged = [];
let heavy = null;
let prText = "";

function receipt() {
  return {
    branch: branch,
    merged: merged,
    set_aside: setAside,
    skipped: skipped,
    heavy_check: heavy,
    open: open,
    children: children,
    pr_text: prText,
  };
}

function taskFile(t) {
  return dir + "/tasks/" + t.id + ".md";
}

function taskGateCommand(t, report) {
  return [
    "recipe-gate task",
    quote(report),
    "--check",
    quote(t.spec.check),
    "--owns",
    quote(t.spec.owns.join(",")),
    "--repo",
    quote(repo),
  ].join(" ");
}

function giveUp(t, reason) {
  t.state = "set_aside";
  t.next = null;
  setAside.push({ id: t.id, reason: short(reason) });
}

function implementBrief(t, report) {
  const lines = [
    "Job: implement one task of a plan.",
    "Task file: " + taskFile(t) + " (read it first)",
    "Plan: " + dir + "/plan.md",
    "Repository: " + repo + " (you are in your own worktree of it, on your own branch)",
    "Task directory: " + dir,
  ];
  if (t.spec.depends.length) {
    lines.push(
      "This task builds on finished tasks. Before the first edit, merge each of these into your branch, in this order, with `git merge --no-ff --no-edit <branch>`: " +
        t.spec.depends
          .map(function (d) {
            return d + " (branch " + byId[d].branch + ")";
          })
          .join(", "),
    );
  }
  lines.push("Commit your work on the branch, leave nothing uncommitted, and leave the task's light check green.");
  lines.push("Write the report to " + report);
  return lines.join("\n");
}

function implementItem(t) {
  const report = dir + "/impl-" + t.id + ".md";
  const item = {
    key: "impl-" + t.id,
    agent: "implementer",
    task: implementBrief(t, report),
    output: report,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    worktree: true,
    gate: { command: taskGateCommand(t, report), output: "json", timeoutMs: 900000 },
  };
  if (t.spec.thinking === "xhigh") {
    if (model) item.model = model + ":xhigh";
    else open.push(t.id + ": the task asks for xhigh thinking and no model was given, so it ran at the role's default");
  }
  return item;
}

function takeImplementation(t, result) {
  if (!result.ok) return giveUp(t, "implementer failed: " + (result.error || "failed"));
  const g = result.structuredOutput;
  if (!g) return giveUp(t, "the task check did not run");
  t.report = result.file;
  t.runId = result.runId || t.runId;
  t.branch = g.branch;
  t.worktree = g.worktree;
  t.base = g.base;
  const status = g.report ? g.report.status : "invalid";
  if (status === "blocked" || status === "failed") return giveUp(t, g.reason);
  if (!g.branch || !g.worktree) return giveUp(t, g.reason || "the task has no branch");
  if (g.ok) {
    t.next = "review";
    return;
  }
  t.next = "fix";
  t.findings = "The task check reported: " + g.reason;
}

function reviewItem(t) {
  t.reviews++;
  const file = dir + "/review-" + t.id + "-" + t.reviews + ".md";
  const lines = [
    "Review a diff on a branch (the diff variant)" + (t.lastReview ? ", re-review after fix round " + t.fixes : "") + ".",
    "Task file: " + taskFile(t),
    "Repository: " + repo,
    "Branch: " + t.branch,
    "Worktree: " + t.worktree + " (read and run the check there; edit nothing in it)",
    "Diff to review: git diff " + t.base + "..." + t.branch,
    "Owned files: " + t.spec.owns.join(", "),
    "Check to run: " + t.spec.check,
    "Implementer report: " + t.report,
  ];
  if (t.lastReview) lines.push("Earlier review: " + t.lastReview);
  lines.push("Write the report to " + file);
  return {
    key: "review-" + t.id + "-" + t.reviews,
    agent: "reviewer",
    task: lines.join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    gate: { command: "recipe-gate verdict " + quote(file), output: "json" },
  };
}

function takeReview(t, result) {
  if (!result.ok || !result.structuredOutput) return giveUp(t, "review failed: " + (result.error || "its verdict gate did not run"));
  t.lastReview = result.file;
  t.lastVerdict = result.structuredOutput.verdict;
  if (t.lastVerdict === "clean") {
    t.state = "done";
    t.next = null;
    return;
  }
  if (t.lastVerdict === "invalid") return giveUp(t, "review verdict unreadable; see " + result.file);
  t.next = "fix";
  t.findings = "The review at " + result.file + " found blocking problems.";
}

function fixItem(t) {
  t.fixes++;
  const file = dir + "/fix-" + t.id + "-" + t.fixes + ".md";
  return {
    key: "fix-" + t.id + "-" + t.fixes,
    resume: t.runId,
    task: [
      "Fix round " + t.fixes + " of " + MAX_FIXES + ".",
      "Continue in your worktree " + t.worktree + " on branch " + t.branch + ".",
      t.findings,
      "Fix the blocking findings only; small findings are recorded, not fixed. Touch only the owned files.",
      "Commit on the same branch, leave nothing uncommitted, run the task's light check (" + t.spec.check + ") and quote its output.",
      "Write the report to " + file,
    ].join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
  };
}

function takeFix(t, result) {
  if (!result.ok) return giveUp(t, "fix round " + t.fixes + " failed: " + (result.error || "failed"));
  t.runId = result.runId || t.runId;
  t.next = "review";
}

const byId = {};
const tasks = [];

function levelOf(t) {
  if (t.level !== undefined) return t.level;
  let level = 0;
  t.spec.depends.forEach(function (d) {
    level = Math.max(level, levelOf(byId[d]) + 1);
  });
  t.level = level;
  return level;
}

function runWave(active) {
  return launch(active.map(implementItem)).then(function (results) {
    active.forEach(function (t, i) {
      takeImplementation(t, results[i]);
    });
    return rounds(active, 0);
  });
}

function rounds(active, round) {
  const toReview = active.filter(function (t) {
    return t.next === "review";
  });
  const reviewed = toReview.length
    ? launch(toReview.map(reviewItem)).then(function (results) {
        toReview.forEach(function (t, i) {
          takeReview(t, results[i]);
        });
      })
    : Promise.resolve();
  return reviewed.then(function () {
    const fixable = [];
    active
      .filter(function (t) {
        return t.next === "fix";
      })
      .forEach(function (t) {
        if (t.fixes >= MAX_FIXES) giveUp(t, "review still " + t.lastVerdict + " after " + MAX_FIXES + " fix rounds; see " + t.lastReview);
        else if (!t.runId) giveUp(t, "the implementer cannot be resumed for a fix round");
        else fixable.push(t);
      });
    const fixed = fixable.length
      ? launch(fixable.map(fixItem)).then(function (results) {
          fixable.forEach(function (t, i) {
            takeFix(t, results[i]);
          });
        })
      : Promise.resolve();
    return fixed.then(function () {
      const pending = active.some(function (t) {
        return t.next !== null;
      });
      return pending && round < MAX_FIXES ? rounds(active, round + 1) : undefined;
    });
  });
}

const intake = await one({
  key: "intake",
  agent: "scout",
  task: "Check that " + dir + "/plan.md can be read, then write the single word done to " + dir + "/intake.md.",
  output: dir + "/intake.md",
  outputMode: "file-only",
  maxRuntimeMs: childMs,
  gate: { command: planGateCommand(), output: "json" },
});

if (!intake.ok || !intake.structuredOutput) {
  open.push("the plan check did not run: " + (intake.error || "no result"));
  return receipt();
}

const plan = intake.structuredOutput;
if (!plan.ok) {
  open.push("the plan is not ready to implement");
  planProblems(plan).forEach(function (p) {
    open.push(p);
  });
  return receipt();
}

list(plan.tasks).forEach(function (spec) {
  const t = {
    id: spec.id,
    spec: spec,
    state: "pending",
    next: null,
    fixes: 0,
    reviews: 0,
    runId: null,
    branch: null,
    worktree: null,
    base: null,
    report: null,
    findings: "",
    lastReview: null,
    lastVerdict: null,
  };
  byId[spec.id] = t;
  tasks.push(t);
});

let top = 0;
tasks.forEach(function (t) {
  top = Math.max(top, levelOf(t));
});

for (let level = 0; level <= top; level++) {
  const active = [];
  tasks
    .filter(function (t) {
      return t.level === level;
    })
    .forEach(function (t) {
      const stuck = t.spec.depends.filter(function (d) {
        return byId[d].state !== "done";
      });
      if (stuck.length) {
        t.state = "skipped";
        skipped.push(t.id);
      } else active.push(t);
    });
  if (active.length) await runWave(active);
}

const finished = [];
for (let level = 0; level <= top; level++) {
  tasks.forEach(function (t) {
    if (t.level === level && t.state === "done") finished.push(t);
  });
}

if (finished.length === 0) {
  open.push("no task finished, so there is nothing to integrate");
  return receipt();
}

const pairs = finished
  .map(function (t) {
    return t.id + ":" + t.branch;
  })
  .join(",");

const integrationReport = dir + "/integration.md";
const integrated = await one({
  key: "integrate",
  agent: "implementer",
  task: [
    "Job: integrate the finished tasks of a plan (a brief, no task file, no worktree of your own).",
    "Repository: " + repo,
    "Plan: " + dir + "/plan.md (the order of its task list is the merge order; it names the heavy checks)",
    "Integration branch: " + integrationBranch,
    "Integration worktree: " + dir + "/integration",
    "Finished tasks, as id:branch: " + pairs,
    "1. Create the branch and worktree from the repository's current HEAD without touching its checkout: git -C " + repo + " worktree add -b " + integrationBranch + " " + dir + "/integration HEAD. If they already exist, continue in them.",
    "2. Merge every finished branch into the integration branch in the order of plan.md's task list, dependencies first. You resolve conflicts; one you cannot resolve ends the job as blocked, naming both sides.",
    "3. From the integration worktree, run each of plan.md's heavy checks once, each under the box-wide lock the environment file names. Write " + dir + "/heavy.md: first line `pass`, `none` (the plan names no heavy check) or `fail: <why>`, then each command, its wait time and its full output.",
    "4. Write the pull request title and body to " + dir + "/pr.md: what changed and why, how it was checked, and the choices made without asking.",
    "Never merge into main and never push. Leave nothing uncommitted in the integration worktree.",
    "Write the report to " + integrationReport,
  ].join("\n"),
  output: integrationReport,
  outputMode: "file-only",
  maxRuntimeMs: bigMs,
  worktree: false,
  gate: {
    command: "recipe-gate integrate " + quote(dir) + " --tasks " + quote(pairs) + " --branch " + quote(integrationBranch),
    output: "json",
  },
});

if (!integrated.ok) {
  open.push("integration failed: " + (integrated.error || "failed"));
  open.push("finished branches: " + pairs);
} else if (!integrated.structuredOutput) {
  open.push("the integration check did not run; finished branches: " + pairs);
} else {
  const g = integrated.structuredOutput;
  branch = g.branch;
  merged = list(g.merged);
  heavy = g.heavy_check;
  prText = g.pr_text || "";
  list(g.reasons).forEach(function (reason) {
    open.push("integration: " + reason);
  });
}

return receipt();
