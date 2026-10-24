import { recipeLib } from "../lib/recipe-lib.mjs";

export default async function implement(args, port) {
  const {
    askDecision,
    board,
    decide,
    diagnose,
    diagnosisItem,
    exhausted,
    exhaustedQuestion,
    launch,
    list,
    node,
    one,
    quote,
    readDiagnosis,
    receipt,
    short,
    stoppedItself,
    subjectOf,
    troubleOf,
  } = recipeLib(port);

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
  const resumed = { done: [], continued: [], answered: [] };
  const answers = args.answers || {};

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
  let pinned = null;
  let tidied = null;
  const made = [];

  function noteMade(id, kind, entryBranch, entryWorktree) {
    if (!entryBranch && !entryWorktree) return;
    const duplicate = made.some(function (m) {
      return m.kind === kind && m.branch === (entryBranch || null) && m.worktree === (entryWorktree || null);
    });
    if (!duplicate) made.push({ id: id, kind: kind, branch: entryBranch || null, worktree: entryWorktree || null });
  }

  function leftBehind() {
    return made.filter(function (m) {
      if (!tidied) return true;
      if (m.kind === "review" || m.kind === "deps" || m.kind === "integration") return false;
      return !(m.kind === "task" && tidied.indexOf(m.id) >= 0);
    });
  }

  function reportLines() {
    const lines = [];
    const ordered = tasks.slice().sort(function (a, b) {
      return a.level - b.level;
    });
    ordered.forEach(function (t) {
      if (t.state === "skipped") return lines.push(t.id + ": skipped (" + t.stuckOn + " not done)");
      if (t.state === "set_aside") {
        const entry = setAside.filter(function (s) {
          return s.id === t.id;
        })[0];
        return lines.push(t.id + ": set aside (" + (entry ? entry.reason : "no reason recorded") + ")");
      }
      lines.push(t.id + (merged.indexOf(t.id) >= 0 ? ": merged" : ": not merged"));
    });
    return lines;
  }

  function finish() {
    const left = leftBehind();
    return receipt({
      base: pinned ? pinned.base : null,
      branch: branch,
      merged: merged,
      set_aside: setAside,
      skipped: skipped,
      report: reportLines(),
      heavy_check: heavy,
      resumed: resumed,
      open: open,
      left: left,
      cleanup: left.length ? "recipe-gate abandon " + quote(dir) + (tidied && branch ? " --keep " + quote(branch) : "") : "",
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
      "--base",
      quote(t.base),
      "--run",
      quote(dir),
      "--id",
      quote(t.id),
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
        "This task builds on finished tasks, and your branch already holds them: " +
          t.spec.depends
            .map(function (d) {
              return d + " (branch " + byId[d].branch + ")";
            })
            .join(", ") +
          ". Do not merge anything.",
      );
    }
    if (t.resumeRef && t.attempts === 1) {
      lines.push("Work already on this branch from an earlier run: continue it; do not start over. The old worktree may be gone; only what was committed on the branch is kept.");
      if (t.earlierReview) lines.push("Earlier review: " + t.earlierReview);
    }
    if (answers[t.id]) lines.push("Decision from the user: " + answers[t.id]);
    lines.push("Commit your work on the branch, leave nothing uncommitted, and leave the task's light check green.");
    lines.push("If the task cannot be done as written, stop and write `blocked: <why>` as the first line of the report; do not ask.");
    lines.push("Write the report to " + report);
    return lines;
  }

  function implementItem(t) {
    t.attempts++;
    const tag = t.attempts === 1 ? t.id : t.id + "-" + t.attempts;
    const report = dir + "/impl-" + tag + ".md";
    const item = node("impl-" + tag, "implementer", implementBrief(t, report), report, {
      gate: taskGateCommand(t, report),
      gateTimeoutMs: 900000,
      timeoutMs: bigMs,
      worktree: true,
    });
    item.baseRef = t.baseRef;
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
    noteMade(t.id, "task", g.branch, g.worktree);
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
      "Worktree: your own worktree of the branch (where the binding names a path: " + dir + "/review/" + t.id + "-" + t.reviews + "); read and run the check there. The implementer's worktree " + t.worktree + " is not yours: never read or run anything in it.",
      "Diff to review: git diff " + t.base + ".." + t.branch,
      "Owned files: " + ownsOf(t).join(", "),
      "Check to run: " + t.spec.check,
      "Implementer report: " + t.report,
    ];
    if (t.replanBrief) lines.push("Revised task (wins over the task file): the ## Brief section of " + t.replanBrief);
    if (t.lastReview) lines.push("Earlier review: " + t.lastReview);
    lines.push("Write the report to " + file);
    const item = node("review-" + t.id + "-" + t.reviews, "reviewer", lines, file, {
      gate: "recipe-gate verdict " + quote(file) + " --run " + quote(dir) + " --id " + quote(t.id),
      timeoutMs: bigMs,
      worktree: true,
    });
    item.baseRef = "refs/heads/" + t.branch;
    item.big = true;
    return item;
  }

  function takeReview(t, result) {
    if (result.structuredOutput) noteMade(t.id, "review", result.structuredOutput.branch, result.structuredOutput.worktree);
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

  const MAX_RESOLVERS = 3;

  function gateOnlyItem(key, command, file) {
    return node(key, "scout", ["Write the single word done to " + file + "."], file, { gate: command, selfGate: false, timeoutMs: childMs });
  }

  function mergeCommand(m) {
    return [
      "recipe-gate merge",
      quote(m.worktree),
      "--dir",
      quote(dir),
      "--branch",
      quote(m.branch),
      "--tips",
      quote(m.tips),
      "--onto",
      quote(m.onto || pinned.base_ref),
      "--kind",
      m.kind,
      "--id",
      m.scope,
    ]
      .concat(args.resume ? ["--refresh", "yes"] : [])
      .join(" ");
  }

  function mergeState(scope, kind, worktree, mergeBranch, tipTasks, onto) {
    return {
      onto: onto || null,
      scope: scope,
      kind: kind,
      worktree: worktree,
      branch: mergeBranch,
      tips: tipTasks
        .map(function (t) {
          return t.id + ":" + t.branch;
        })
        .join(","),
      resolvers: 0,
      last: null,
    };
  }

  function sameConflict(a, b) {
    return a.id === b.id && list(a.files).join("\n") === list(b.files).join("\n");
  }

  function resolverItem(m, g) {
    m.resolvers++;
    const conflicting = byId[g.conflict.id];
    const file = dir + "/resolve-" + m.scope + "-" + m.resolvers + ".md";
    const before = list(g.merged)
      .filter(function (id) {
        return byId[id];
      })
      .map(function (id) {
        return taskFile(byId[id]);
      });
    const lines = [
      "Job: resolve one merge conflict (a brief, no task file).",
      "Worktree: " + m.worktree + " (on branch " + m.branch + "; the merge is already started there)",
      "Branch being merged: " + (conflicting ? conflicting.branch : g.conflict.id),
      "Conflicted files: " + list(g.conflict.files).join(", "),
      "Task file of the conflicting task: " + (conflicting ? taskFile(conflicting) : "none"),
      "Task files of the tasks already merged: " + (before.length ? before.join(", ") : "none"),
      "Edit only the conflicted files, `git add` them and run `git commit --no-edit`. Never start, abort or redo a merge, and never edit the repository checkout " + repo + ".",
    ];
    if (conflicting) lines.push("Then run the conflicting task's check and quote its output: " + conflicting.spec.check);
    lines.push("If the conflict cannot be resolved by editing those files alone, stop and write `blocked: <why>` as the first line of the report; do not ask.");
    lines.push("Write the report to " + file);
    const command = mergeCommand(m) + (conflicting ? " --check " + quote(conflicting.spec.check) : "");
    return node("resolve-" + m.scope + "-" + m.resolvers, "implementer", lines, file, {
      gate: command,
      gateTimeoutMs: 900000,
      selfGate: false,
      timeoutMs: bigMs,
      worktree: false,
    });
  }

  // Settles the result of a merge gate: a conflict goes to a resolver, whose own
  // gate repeats the merge. Resolves to { ok, g, why }.
  function settle(m, result) {
    const g = result.structuredOutput;
    const failure = function (why) {
      return Promise.resolve({ ok: false, g: g, why: why });
    };
    if (g) noteMade(m.scope, m.kind, g.branch || m.branch, g.worktree || m.worktree);
    if (!result.ok || !g) return failure("the merge did not run: " + (result.error || "no result"));
    if (g.ok) return Promise.resolve({ ok: true, g: g, why: "" });
    if (!g.conflict) return failure(g.reason || "the merge failed");
    const where = "conflict merging " + g.conflict.id + " in " + list(g.conflict.files).join(", ");
    if (m.last && sameConflict(m.last, g.conflict)) {
      const why = g.reason && !/has conflicts$/.test(g.reason) ? ": " + g.reason : "";
      return failure(where + ", left as it was by the resolver" + why);
    }
    if (m.resolvers >= MAX_RESOLVERS) return failure(where + ", still open after " + MAX_RESOLVERS + " resolvers");
    m.last = g.conflict;
    return one(resolverItem(m, g)).then(function (next) {
      return settle(m, next);
    });
  }

  function depsItem(t, m) {
    return gateOnlyItem("deps-" + t.id, mergeCommand(m), dir + "/deps-" + t.id + ".md");
  }

  function prepare(active) {
    active.forEach(function (t) {
      if (!t.spec.depends.length) {
        t.baseRef = t.resumeRef || pinned.base_ref;
        t.base = pinned.base;
      }
    });
    const due = active.filter(function (t) {
      return t.spec.depends.length > 0;
    });
    if (due.length === 0) return Promise.resolve();
    const states = due.map(function (t) {
      return mergeState(
        t.id,
        "deps",
        dir + "/deps/" + t.id,
        integrationBranch + "-deps-" + t.id,
        t.spec.depends
          .map(function (d) {
            return byId[d];
          })
          .filter(function (d) {
            return !d.gone;
          }),
        t.spec.depends.some(function (d) {
          return byId[d].gone;
        })
          ? "refs/heads/" + integrationBranch
          : null,
      );
    });
    return launch(
      due.map(function (t, i) {
        return depsItem(t, states[i]);
      }),
    ).then(function (results) {
      return due.reduce(function (chain, t, i) {
        return chain
          .then(function () {
            return settle(states[i], results[i]);
          })
          .then(function (out) {
            if (out.ok) {
              t.baseRef = t.resumeRef || "refs/heads/" + out.g.branch;
              t.base = out.g.head;
              return;
            }
            askPerson(t, "deps", "the tasks that task " + t.id + " builds on could not be merged: " + out.why);
          });
      }, Promise.resolve());
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

  const pin = await one(gateOnlyItem("pin", "recipe-gate pin " + quote(dir) + " --repo " + quote(repo), dir + "/pin.md"));
  if (!pin.ok || !pin.structuredOutput) {
    open.push("the base could not be pinned: " + (pin.error || "the pin did not run"));
    return finish();
  }
  if (!pin.structuredOutput.ok) {
    open.push("the base could not be pinned: " + pin.structuredOutput.reason);
    return finish();
  }
  pinned = pin.structuredOutput;

  list(plan.tasks).forEach(function (spec) {
    const t = Object.assign(subjectOf(spec.id), {
      spec: spec,
      state: "pending",
      next: null,
      attempts: 0,
      fixes: 0,
      extraFix: false,
      reviews: 0,
      earlierReview: null,
      gone: false,
      extraOwns: [],
      replanBrief: null,
      runId: null,
      resumeRef: null,
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

  if (args.resume) {
    const back = await one(
      gateOnlyItem(
        "resume",
        "recipe-gate resume " + quote(dir) + " --repo " + quote(repo) + " --branch " + quote(integrationBranch),
        dir + "/resume.md",
      ),
    );
    if (!back.ok || !back.structuredOutput || !back.structuredOutput.ok) {
      open.push(
        "the earlier run could not be read, so this run starts fresh: " +
          ((back.structuredOutput && back.structuredOutput.reason) || back.error || "the resume did not run"),
      );
    } else {
      const last = back.structuredOutput.tasks || {};
      tasks.forEach(function (t) {
        const entry = last[t.id];
        if (!entry) return;
        const answered = !!answers[t.id];
        if (!answered && (entry.merged || (entry.head && entry.review === "clean"))) {
          t.state = "done";
          t.branch = entry.branch;
          t.base = pinned.base;
          t.gone = !entry.head;
          noteMade(t.id, "task", entry.branch, null);
          resumed.done.push(t.id);
          return;
        }
        if (!entry.head) {
          open.push("task " + t.id + ": its earlier branch " + entry.branch + " was gone, so it runs fresh");
          return;
        }
        t.resumeRef = "refs/heads/" + entry.branch;
        t.reviews = entry.reviews || 0;
        t.earlierReview = entry.review_file || null;
        resumed.continued.push(t.id);
      });
    }
  }

  tasks.forEach(function (t) {
    if (answers[t.id]) resumed.answered.push(t.id);
  });
  Object.keys(answers).forEach(function (id) {
    if (!byId[id]) open.push("an answer was given for " + id + ", which is not a task of this plan");
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
        if (t.state === "done") return;
        const stuck = t.spec.depends.filter(function (d) {
          return byId[d].state !== "done";
        });
        if (stuck.length) {
          t.state = "skipped";
          t.stuckOn = stuck[0];
          skipped.push(t.id);
        } else {
          t.state = "running";
          t.next = "implement";
          active.push(t);
        }
      });
    if (active.length) {
      await prepare(active);
      const ready = active.filter(function (t) {
        return t.state === "running";
      });
      if (ready.length) await cycle(ready, 0, "wave " + (level + 1));
    }
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

  const present = finished.filter(function (t) {
    return !t.gone;
  });
  if (present.length === 0) {
    branch = integrationBranch;
    merged = finished.map(function (t) {
      return t.id;
    });
    open.push("nothing new to integrate: every finished task is already merged into " + integrationBranch);
    return finish();
  }
  const pairs = present
    .map(function (t) {
      return t.id + ":" + t.branch;
    })
    .join(",");

  const wanted = {};
  present.forEach(function (t) {
    Object.keys(ancestors(t)).forEach(function (d) {
      wanted[d] = true;
    });
  });
  const tipTasks = present.filter(function (t) {
    return !wanted[t.id];
  });

  function integrationItem(attempt, diagnosisFile) {
    const report = dir + (attempt === 1 ? "/integration.md" : "/integration-" + attempt + ".md");
    const lines = [
      "Job: integrate the finished tasks of a plan (a brief, no task file).",
      "Repository: " + repo + " (never edit its checkout)",
      "Plan: " + dir + "/plan.md (it names the heavy checks)",
      "Integration branch: " + integrationBranch,
      "Integration worktree: " + dir + "/integration (already made, with every finished branch merged into it; work only there)",
      "Finished tasks, as id:branch: " + pairs,
    ];
    if (diagnosisFile) lines.push("An earlier attempt did not finish; the diagnosis at " + diagnosisFile + " says why, and its ## Brief section says what to do differently.");
    lines.push(
      "1. From the integration worktree, run each of plan.md's heavy checks once, each under the box-wide lock the environment file names. Write " + dir + "/heavy.md: first line `pass`, `none` (the plan names no heavy check) or `fail: <why>`, then each command, its wait time and its full output.",
      "2. Write the pull request title and body to " + dir + "/pr.md: what changed and why, nothing else. No checklist of how it was checked and no operator steps; a choice made without asking goes in only where it is part of the why.",
      "Create no worktree and merge nothing. Never merge into main and never push. Leave nothing uncommitted in the integration worktree.",
      "Write the report to " + report,
    );
    const item = node(attempt === 1 ? "integrate" : "integrate-" + attempt, "implementer", lines, report, {
      gate: "recipe-gate integrate " + quote(dir) + " --tasks " + quote(pairs) + " --branch " + quote(integrationBranch) + " --tidy yes",
      selfGate: false,
      timeoutMs: bigMs,
      worktree: false,
    });
    item.big = true;
    return item;
  }

  function integrationTrouble(result) {
    if (!result.ok) return "the integration failed twice: " + (result.error || "failed");
    if (!result.structuredOutput) return "the integration check did not run";
    if (!result.structuredOutput.ok) return "the integration check found: " + list(result.structuredOutput.reasons).join("; ");
    return null;
  }

  board("integrating", view());
  const joining = mergeState("integration", "integration", dir + "/integration", integrationBranch, tipTasks);
  const joined = await one(gateOnlyItem("merge", mergeCommand(joining), dir + "/merge.md"));
  const joinedOut = await settle(joining, joined);
  if (!joinedOut.ok) {
    askDecision(subjectOf("integration"), "integrate", "the finished branches could not be merged: " + joinedOut.why, null);
    open.push("integration merge: " + joinedOut.why);
    open.push("integration worktree: " + joining.worktree + " on branch " + integrationBranch);
    open.push("finished branches: " + pairs);
    return finish();
  }

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
    merged = finished
      .filter(function (t) {
        return t.gone;
      })
      .map(function (t) {
        return t.id;
      })
      .concat(list(g.merged));
    heavy = g.heavy_check;
    prText = g.pr_text || "";
    if (g.ok) tidied = merged;
    list(g.reasons).forEach(function (reason) {
      open.push("integration: " + reason);
    });
    list(g.tidy_problems).forEach(function (p) {
      open.push("cleanup: " + p);
    });
  }

  return finish();
}
