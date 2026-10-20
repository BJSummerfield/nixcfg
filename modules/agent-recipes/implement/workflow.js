const MAX_FIXES = 2;
const MAX_HEALS = 2;
const MAX_CYCLES = 12;
const REASON_CHARS = 300;

const dir = args.plan;
const repo = args.repo;
const model = args.model;
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
const healed = [];
const decide = [];
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

// pi-subagents marks a writer that reports its own work as not done as
// failed; running the same brief again gets the same answer, so it is not
// retried and its report goes to a diagnosis instead.
function stoppedItself(result) {
  return /reported as not-satisfied/.test(String(result.error || ""));
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
      if (!result.ok && !stoppedItself(result)) {
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
    healed: healed,
    decide: decide,
    open: open,
    children: children,
    pr_text: prText,
  };
}

const byId = {};
const tasks = [];

function board(stage) {
  if (typeof emit !== "function") return;
  emit({
    stage: stage,
    tasks: tasks.map(function (t) {
      return { id: t.id, state: t.state, next: t.next, fixes: t.fixes, heals: t.heals };
    }),
    healed: healed,
    decide: decide,
  });
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

function askPerson(t, question, file) {
  giveUp(t, "needs a decision: " + question);
  decide.push({ id: t.id, question: short(question), diagnosis: file || null });
}

// A step whose output was not accepted goes to a diagnose child, which picks
// one of the allowed actions; the cap and the signature check keep healing
// from looping.
function heal(t, step, signal, evidence, allowed) {
  if (t.heals >= MAX_HEALS) return askPerson(t, signal + " (still failing after " + MAX_HEALS + " recoveries)", t.lastDiagnosis);
  t.next = "heal";
  t.trouble = { step: step, signal: short(signal), evidence: evidence.filter(Boolean), allowed: allowed };
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
  return lines.join("\n");
}

function implementItem(t) {
  t.attempts++;
  const tag = t.attempts === 1 ? t.id : t.id + "-" + t.attempts;
  const report = dir + "/impl-" + tag + ".md";
  const item = {
    key: "impl-" + tag,
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
    else if (t.attempts === 1) open.push(t.id + ": the task asks for xhigh thinking and no model was given, so it ran at the role's default");
  }
  return item;
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
  return {
    key: "fix-" + t.id + "-" + t.fixes,
    resume: t.runId,
    task: [
      extra ? "Extra fix round " + t.fixes + ", from a diagnosis." : "Fix round " + t.fixes + " of " + MAX_FIXES + ".",
      "Continue in your worktree " + t.worktree + " on branch " + t.branch + ".",
      t.findings,
      "Fix the blocking findings only; small findings are recorded, not fixed. Touch only the owned files: " + ownsOf(t).join(", ") + ".",
      "Commit on the same branch, leave nothing uncommitted, run the task's light check (" + t.spec.check + ") and quote its output.",
      "Write the report to " + file,
    ].join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
  };
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

function diagnoseItem(subject) {
  subject.heals++;
  const c = subject.trouble;
  const file = dir + "/diagnosis-" + subject.id + "-" + subject.heals + ".md";
  let command = "recipe-gate diagnosis " + quote(file) + " --allow " + quote(c.allowed.join(","));
  if (c.allowed.indexOf("continue") >= 0 && c.step === "review") command += " --verdict yes";
  const lines = [
    "Diagnose a step whose output the script did not accept (the diagnosis variant).",
    "Plan: " + dir + "/plan.md",
    "Repository: " + repo,
  ];
  if (subject.spec) lines.push("Task file: " + taskFile(subject) + (subject.extraOwns.length ? " (also may change: " + subject.extraOwns.join(", ") + ")" : ""));
  if (subject.worktree) lines.push("Worktree: " + subject.worktree + (subject.branch ? " on branch " + subject.branch : "") + " (read it, run checks in it, edit nothing)");
  lines.push("Step: " + STEPS[c.step]);
  lines.push("What went wrong: " + c.signal);
  if (c.evidence.length) lines.push("Evidence: " + c.evidence.join(", "));
  if (subject.lastDiagnosis) lines.push("Earlier diagnosis: " + subject.lastDiagnosis);
  if (c.step === "review" && c.allowed.indexOf("continue") >= 0) lines.push("With continue, give the verdict the review states.");
  lines.push("Allowed actions: " + c.allowed.join(", "));
  lines.push("Write the diagnosis to " + file);
  return {
    key: "diagnose-" + subject.id + "-" + subject.heals,
    agent: "reviewer",
    task: lines.join("\n"),
    output: file,
    outputMode: "file-only",
    maxRuntimeMs: childMs,
    gate: { command: command, output: "json" },
  };
}

function readDiagnosis(subject, result) {
  subject.lastDiagnosis = result.file;
  if (!result.ok || !result.structuredOutput) return { problem: "the diagnosis failed: " + (result.error || "no result") };
  const d = result.structuredOutput;
  if (!d.ok) return { problem: "the diagnosis could not be read: " + d.problem };
  const signature = subject.trouble.step + ":" + d.action + ":" + String(d.reason).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (subject.signatures.indexOf(signature) >= 0) return { problem: "the same diagnosis came back twice: " + d.reason };
  subject.signatures.push(signature);
  if (d.action !== "decide") healed.push({ id: subject.id, step: subject.trouble.step, action: d.action, reason: short(d.reason) });
  return d;
}

function takeDiagnosis(t, result) {
  const d = readDiagnosis(t, result);
  if (d.problem) return askPerson(t, t.trouble.signal + "; " + d.problem, result.file);
  const step = t.trouble.step;
  t.trouble = null;
  if (d.action === "decide") return askPerson(t, d.reason, result.file);
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
    if (!t.runId) return askPerson(t, "the diagnosis asks for a fix, but the implementer cannot be resumed: " + d.reason, result.file);
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
      return askPerson(t, "the revised task needs " + d.owns[i] + ", which task " + others[0].id + " owns and this task does not build on", result.file);
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
      board(label + ", round " + (n + 1));
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
    attempts: 0,
    fixes: 0,
    extraFix: false,
    reviews: 0,
    heals: 0,
    signatures: [],
    trouble: null,
    extraOwns: [],
    replanBrief: null,
    lastDiagnosis: null,
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

board("plan accepted");

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
  board("finished");
  return receipt();
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
    "4. Write the pull request title and body to " + dir + "/pr.md: what changed and why, how it was checked, and the choices made without asking.",
    "Never merge into main and never push. Leave nothing uncommitted in the integration worktree.",
    "Write the report to " + report,
  );
  return {
    key: attempt === 1 ? "integrate" : "integrate-" + attempt,
    agent: "implementer",
    task: lines.join("\n"),
    output: report,
    outputMode: "file-only",
    maxRuntimeMs: bigMs,
    worktree: false,
    gate: {
      command: "recipe-gate integrate " + quote(dir) + " --tasks " + quote(pairs) + " --branch " + quote(integrationBranch) + " --tidy yes",
      output: "json",
    },
  };
}

function integrationTrouble(result) {
  if (!result.ok) return "the integration failed twice: " + (result.error || "failed");
  if (!result.structuredOutput) return "the integration check did not run";
  if (!result.structuredOutput.ok) return "the integration check found: " + list(result.structuredOutput.reasons).join("; ");
  return null;
}

board("integrating");
let integrated = await one(integrationItem(1, null));
const problem = integrationTrouble(integrated);
if (problem) {
  const subject = {
    id: "integration",
    heals: 0,
    signatures: [],
    lastDiagnosis: null,
    worktree: dir + "/integration",
    branch: integrationBranch,
    trouble: { step: "integrate", signal: short(problem), evidence: [integrated.file, dir + "/heavy.md"], allowed: ["retry", "decide"] },
  };
  const diagnosed = await one(diagnoseItem(subject));
  const d = readDiagnosis(subject, diagnosed);
  if (d.problem) decide.push({ id: "integration", question: short(problem + "; " + d.problem), diagnosis: diagnosed.file });
  else if (d.action === "decide") decide.push({ id: "integration", question: short(d.reason), diagnosis: diagnosed.file });
  else integrated = await one(integrationItem(2, diagnosed.file));
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

board("finished");
return receipt();
