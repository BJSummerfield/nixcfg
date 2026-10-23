const MAX_FIXES = 2;
const MAX_CYCLES = 12;

const dir = args.plan;
const repo = args.repo;
const childMs = args.childTimeoutMs || 1200000;
const bigMs = args.bigTimeoutMs || 3600000;
const slug = String(dir).replace(/\/+$/, "").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "-") || "plan";
const integrationBranch = args.branch || "implement/" + slug;

const STEPS = {
  implement: "the implementer's run (its report and the task check run in its worktree)",
  review: "the review of the task's diff",
  fix: "a fix round, resumed in the implementer's worktree",
  integrate: "the integration of the finished branches, the heavy checks and the pull request text",
};

const open = [];
const setAside = [];
const skipped = [];

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

function finish() {
  return receipt({
    branch: branch,
    merged: merged,
    set_aside: setAside,
    skipped: skipped,
    heavy_check: heavy,
    open: open,
    pr_text: prText,
  });
}

const byId = {};
const tasks = [];

function view() {
  return {
    tasks: tasks.map(function (t) {
      return { id: t.id, state: t.state, next: t.next, fixes: t.fixes, heals: t.heals };
    }),
  };
}

function taskFile(t) {
  return dir + "/tasks/" + t.id + ".md";
}

function ownsOf(t) {
  return t.spec.owns.concat(t.extraOwns);
}

function taskGateCommand(t, report) {
  return [
    "recipe-gate task",
    quote(report),
    "--check",
    quote(t.spec.check),
    "--owns",
    quote(ownsOf(t).join(",")),
    "--repo",
    quote(repo),
  ].join(" ");
}

function giveUp(t, reason) {
  t.state = "set_aside";
  t.next = null;
  setAside.push({ id: t.id, reason: short(reason) });
}

function askPerson(t, step, question, file) {
  askDecision(t, step, question, file);
  giveUp(t, "needs a decision: " + short(question));
}

function heal(t, step, signal, evidence, allowed) {
  const trouble = troubleOf(step, signal, evidence, allowed);
  if (exhausted(t)) return askPerson(t, step, exhaustedQuestion(trouble), t.lastDiagnosis);
  t.next = "heal";
  t.trouble = trouble;
}

function ancestors(t, seen) {
  const out = seen || {};
  t.spec.depends.forEach(function (d) {
    if (!out[d]) {
      out[d] = true;
      ancestors(byId[d], out);
    }
  });
  return out;
}

function ownerOf(path, t) {
  return tasks.filter(function (o) {
    return (
      o !== t &&
      ownsOf(o).some(function (p) {
        return p === path || path.indexOf(p + "/") === 0 || p.indexOf(path + "/") === 0;
      })
    );
  });
}

function implementBrief(t, report) {
  const lines = [
    "Job: implement one task of a plan.",
    "Task file: " + taskFile(t) + " (read it first)",
    "Plan: " + dir + "/plan.md",
    "Repository: " + repo + " (you are in your own worktree of it, on your own branch)",
    "Task directory: " + dir,
  ];
  if (t.spec.research) {
    lines.push("Research notes gathered for this task, if any, answer: " + t.spec.research + ". They are under " + dir + "/research/" + t.id + "/; list that directory and read what is there before the first edit.");
  }
  if (t.replanBrief) {
    lines.push(
      "This is attempt " + t.attempts + ". An earlier attempt did not work; the diagnosis at " + t.replanBrief + " says why, and its ## Brief section is the revised task, which wins over the task file where they differ.",
    );
  }
  if (t.extraOwns.length) lines.push("Besides the task's own files you may change: " + t.extraOwns.join(", "));
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
  lines.push("If the task cannot be done as written, stop and write `blocked: <why>` as the first line of the report; do not ask.");
  lines.push("Write the report to " + report);
  return lines;
}

function implementItem(t) {
  t.attempts++;
  const tag = t.attempts === 1 ? t.id : t.id + "-" + t.attempts;
  const report = dir + "/impl-" + tag + ".md";
  return node("impl-" + tag, "implementer", implementBrief(t, report), report, {
    gate: taskGateCommand(t, report),
    gateTimeoutMs: 900000,
    timeoutMs: bigMs,
    worktree: true,
  });
}

function takeImplementation(t, result) {
  const g = result.structuredOutput;
  if (!result.ok && !(g && g.report)) {
    return heal(t, "implement", "the implementer failed twice: " + (result.error || "failed"), [result.file], ["replan", "decide"]);
  }
  if (!g) return heal(t, "implement", "the task check did not run", [result.file], ["retry", "decide"]);
  t.report = result.file;
  t.runId = result.runId || t.runId;
  t.branch = g.branch;
  t.worktree = g.worktree;
  t.base = g.base;
  const status = g.report ? g.report.status : "invalid";
  if (status === "blocked" || status === "failed") {
    return heal(t, "implement", "the implementer reported " + status + ": " + g.reason, [result.file], ["replan", "decide"]);
  }
  if (!g.branch || !g.worktree) return heal(t, "implement", g.reason || "the task has no branch", [result.file], ["retry", "replan", "decide"]);
  if (g.ok) {
    t.next = "review";
    return;
  }
  needFix(t, "The task check reported: " + g.reason);
}

function needFix(t, findings) {
  if (t.fixes >= MAX_FIXES && !t.extraFix) {
    return heal(
      t,
      "review",
      "still not clean after " + MAX_FIXES + " fix rounds: " + findings,
      [t.lastReview, t.report],
      ["fix", "replan", "decide"],
    );
  }
  t.next = "fix";
  t.findings = findings;
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
    "Owned files: " + ownsOf(t).join(", "),
    "Check to run: " + t.spec.check,
    "Implementer report: " + t.report,
  ];
  if (t.replanBrief) lines.push("Revised task (wins over the task file): the ## Brief section of " + t.replanBrief);
  if (t.lastReview) lines.push("Earlier review: " + t.lastReview);
  lines.push("Write the report to " + file);
  return node("review-" + t.id + "-" + t.reviews, "reviewer", lines, file, {
    gate: "recipe-gate verdict " + quote(file),
    timeoutMs: bigMs,
  });
}

function takeReview(t, result) {
  if (!result.ok || !result.structuredOutput) {
    return heal(t, "review", "the reviewer failed: " + (result.error || "its verdict gate did not run"), [result.file], ["retry", "decide"]);
  }
  t.lastReview = result.file;
  t.lastVerdict = result.structuredOutput.verdict;
  if (t.lastVerdict === "clean") {
    t.state = "done";
    t.next = null;
    return;
  }
  if (t.lastVerdict === "invalid") {
    return heal(t, "review", "the review's verdict could not be read", [result.file], ["continue", "retry", "decide"]);
  }
  needFix(t, "The review at " + result.file + " found blocking problems.");
}

function fixItem(t) {
  t.fixes++;
  const extra = t.fixes > MAX_FIXES;
  t.extraFix = false;
  const file = dir + "/fix-" + t.id + "-" + t.fixes + ".md";
  return node(
    "fix-" + t.id + "-" + t.fixes,
    undefined,
    [
      extra ? "Extra fix round " + t.fixes + ", from a diagnosis." : "Fix round " + t.fixes + " of " + MAX_FIXES + ".",
      "Continue in your worktree " + t.worktree + " on branch " + t.branch + ".",
      t.findings,
      "Fix the blocking findings only; small findings are recorded, not fixed. Touch only the owned files: " + ownsOf(t).join(", ") + ".",
      "Commit on the same branch, leave nothing uncommitted, run the task's light check (" + t.spec.check + ") and quote its output.",
      "Write the report to " + file,
    ],
    file,
    { timeoutMs: bigMs, resume: t.runId },
  );
}

function takeFix(t, result) {
  if (!result.ok) {
    const signal = stoppedItself(result)
      ? "fix round " + t.fixes + " reported that it cannot finish"
      : "fix round " + t.fixes + " failed twice: " + (result.error || "failed");
    return heal(t, "fix", signal, [result.file, t.lastReview], ["replan", "decide"]);
  }
  t.runId = result.runId || t.runId;
  t.next = "review";
}

function diagnosisContext(t) {
  const lines = ["Plan: " + dir + "/plan.md", "Repository: " + repo];
  lines.push("Task file: " + taskFile(t) + (t.extraOwns.length ? " (also may change: " + t.extraOwns.join(", ") + ")" : ""));
  if (t.worktree) lines.push("Worktree: " + t.worktree + (t.branch ? " on branch " + t.branch : "") + " (read it, run checks in it, edit nothing)");
  return lines;
}

function diagnoseItem(t) {
  return diagnosisItem(t, t.trouble, dir, diagnosisContext(t), STEPS[t.trouble.step], childMs);
}

function takeDiagnosis(t, result) {
  const trouble = t.trouble;
  const d = readDiagnosis(t, trouble, result);
  if (!d) {
    t.trouble = null;
    return giveUp(t, "needs a decision: " + decide[decide.length - 1].question);
  }
  const step = trouble.step;
  t.trouble = null;
  if (d.action === "continue") {
    if (d.verdict === "clean") {
      t.state = "done";
      t.next = null;
      return;
    }
    t.lastVerdict = "needs-work";
    return needFix(t, "The review at " + t.lastReview + " found blocking problems.");
  }
  if (d.action === "retry") {
    t.next = step;
    return;
  }
  if (d.action === "fix") {
    if (!t.runId) return askPerson(t, step, "the diagnosis asks for a fix, but the implementer cannot be resumed: " + d.reason, result.file);
    t.findings = "The diagnosis at " + result.file + " found: " + d.reason + " Follow its ## Brief section.";
    t.extraFix = true;
    t.next = "fix";
    return;
  }
  const reach = ancestors(t);
  for (let i = 0; i < d.owns.length; i++) {
    const others = ownerOf(d.owns[i], t).filter(function (o) {
      return !reach[o.id];
    });
    if (others.length) {
      return askPerson(t, step, "the revised task needs " + d.owns[i] + ", which task " + others[0].id + " owns and this task does not build on", result.file);
    }
  }
  d.owns.forEach(function (p) {
    if (ownsOf(t).indexOf(p) < 0) t.extraOwns.push(p);
  });
  t.replanBrief = result.file;
  t.fixes = 0;
  t.extraFix = false;
  t.lastReview = null;
  t.runId = null;
  t.next = "implement";
}

function levelOf(t) {
  if (t.level !== undefined) return t.level;
  let level = 0;
  t.spec.depends.forEach(function (d) {
    level = Math.max(level, levelOf(byId[d]) + 1);
  });
  t.level = level;
  return level;
}

function phase(active, state, make, take) {
  const due = active.filter(function (t) {
    return t.next === state;
  });
  if (due.length === 0) return Promise.resolve();
  return launch(due.map(make)).then(function (results) {
    due.forEach(function (t, i) {
      take(t, results[i]);
    });
  });
}

function cycle(active, n, label) {
  return phase(active, "implement", implementItem, takeImplementation)
    .then(function () {
      return phase(active, "review", reviewItem, takeReview);
    })
    .then(function () {
      return phase(active, "heal", diagnoseItem, takeDiagnosis);
    })
    .then(function () {
      active.forEach(function (t) {
        if (t.next === "fix" && !t.runId) heal(t, "fix", "the implementer cannot be resumed for a fix round", [t.report], ["replan", "decide"]);
      });
      return phase(active, "fix", fixItem, takeFix);
    })
    .then(function () {
      board(label + ", round " + (n + 1), view());
      const pending = active.filter(function (t) {
        return t.next !== null;
      });
      if (pending.length === 0) return undefined;
      if (n + 1 >= MAX_CYCLES) {
        pending.forEach(function (t) {
          giveUp(t, "still unsettled after " + MAX_CYCLES + " rounds");
        });
        return undefined;
      }
      return cycle(active, n + 1, label);
    });
}

const intake = await one(
  node(
    "intake",
    "scout",
    ["Check that " + dir + "/plan.md can be read, then write the single word done to " + dir + "/intake.md."],
    dir + "/intake.md",
    { gate: planGateCommand(), selfGate: false, timeoutMs: childMs },
  ),
);

if (!intake.ok || !intake.structuredOutput) {
  open.push("the plan check did not run: " + (intake.error || "no result"));
  return finish();
}

const plan = intake.structuredOutput;
if (!plan.ok) {
  open.push("the plan is not ready to implement");
  planProblems(plan).forEach(function (p) {
    open.push(p);
  });
  return finish();
}

list(plan.tasks).forEach(function (spec) {
  const t = Object.assign(subjectOf(spec.id), {
    spec: spec,
    state: "pending",
    next: null,
    attempts: 0,
    fixes: 0,
    extraFix: false,
    reviews: 0,
    extraOwns: [],
    replanBrief: null,
    runId: null,
    branch: null,
    worktree: null,
    base: null,
    report: null,
    findings: "",
    lastReview: null,
    lastVerdict: null,
  });
  byId[spec.id] = t;
  tasks.push(t);
});

let top = 0;
tasks.forEach(function (t) {
  top = Math.max(top, levelOf(t));
});

board("plan accepted", view());

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
      } else {
        t.state = "running";
        t.next = "implement";
        active.push(t);
      }
    });
  if (active.length) await cycle(active, 0, "wave " + (level + 1));
}

const finished = [];
for (let level = 0; level <= top; level++) {
  tasks.forEach(function (t) {
    if (t.level === level && t.state === "done") finished.push(t);
  });
}

if (finished.length === 0) {
  open.push("no task finished, so there is nothing to integrate");
  return finish();
}

const pairs = finished
  .map(function (t) {
    return t.id + ":" + t.branch;
  })
  .join(",");

function integrationItem(attempt, diagnosisFile) {
  const report = dir + (attempt === 1 ? "/integration.md" : "/integration-" + attempt + ".md");
  const lines = [
    "Job: integrate the finished tasks of a plan (a brief, no task file, no worktree of your own).",
    "Repository: " + repo,
    "Plan: " + dir + "/plan.md (the order of its task list is the merge order; it names the heavy checks)",
    "Integration branch: " + integrationBranch,
    "Integration worktree: " + dir + "/integration",
    "Finished tasks, as id:branch: " + pairs,
  ];
  if (diagnosisFile) lines.push("An earlier attempt did not finish; the diagnosis at " + diagnosisFile + " says why, and its ## Brief section says what to do differently.");
  lines.push(
    "1. Create the branch and worktree from the repository's current HEAD without touching its checkout: git -C " + repo + " worktree add -b " + integrationBranch + " " + dir + "/integration HEAD. If they already exist, continue in them.",
    "2. Merge every finished branch into the integration branch in the order of plan.md's task list, dependencies first. You resolve conflicts; one you cannot resolve ends the job as blocked, naming both sides.",
    "3. From the integration worktree, run each of plan.md's heavy checks once, each under the box-wide lock the environment file names. Write " + dir + "/heavy.md: first line `pass`, `none` (the plan names no heavy check) or `fail: <why>`, then each command, its wait time and its full output.",
    "4. Write the pull request title and body to " + dir + "/pr.md: what changed and why, nothing else. No checklist of how it was checked and no operator steps; a choice made without asking goes in only where it is part of the why.",
    "Never merge into main and never push. Leave nothing uncommitted in the integration worktree.",
    "Write the report to " + report,
  );
  return node(attempt === 1 ? "integrate" : "integrate-" + attempt, "implementer", lines, report, {
    gate: "recipe-gate integrate " + quote(dir) + " --tasks " + quote(pairs) + " --branch " + quote(integrationBranch) + " --tidy yes",
    selfGate: false,
    timeoutMs: bigMs,
    worktree: false,
  });
}

function integrationTrouble(result) {
  if (!result.ok) return "the integration failed twice: " + (result.error || "failed");
  if (!result.structuredOutput) return "the integration check did not run";
  if (!result.structuredOutput.ok) return "the integration check found: " + list(result.structuredOutput.reasons).join("; ");
  return null;
}

board("integrating", view());
let integrated = await one(integrationItem(1, null));
const problem = integrationTrouble(integrated);
if (problem) {
  const subject = subjectOf("integration");
  const trouble = troubleOf("integrate", problem, [integrated.file, dir + "/heavy.md"], ["retry", "decide"]);
  const context = ["Plan: " + dir + "/plan.md", "Repository: " + repo, "Worktree: " + dir + "/integration on branch " + integrationBranch + " (read it, run checks in it, edit nothing)"];
  const d = await diagnose(subject, trouble, dir, context, STEPS.integrate, childMs);
  if (d) integrated = await one(integrationItem(2, d.file));
}

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
  list(g.tidy_problems).forEach(function (p) {
    open.push("cleanup: " + p);
  });
}

return finish();
