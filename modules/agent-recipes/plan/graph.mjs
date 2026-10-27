import { recipeLib } from "../lib/recipe-lib.mjs";

export default async function plan(args, port) {
  const { quote, sibling, list, passed, node, launch, one, subjectOf, troubleOf, diagnose, searchItem, extractItem, rankAndCap, sourcesFound, board, receipt } = recipeLib(port);

  const MAX_REVISIONS = 2;
  const MAX_RESEARCH_SOURCES = 3;

  const dir = args.dir;
  const goal = args.goal;
  const input = args.input;
  const repo = args.repo;

  const STEPS = {
    plan: "the planner's run (plan.md, the task files and the plan check)",
    review: "the review of the plan",
  };

  const open = [];
  const research = {};
  const wholeRun = subjectOf(null);
  let last = null;
  let reviewVerdict = null;
  let reviews = 0;
  let revisions = 0;

  function view() {
    return { tasks: last ? list(last.tasks).length : 0, plan_ok: last ? Boolean(last.ok) : null, review: reviewVerdict, research: research };
  }

  function show(stage) {
    board(stage, view());
  }

  function finish() {
    return receipt({
      plan_dir: dir,
      tasks: last ? list(last.tasks).length : 0,
      oversize: last ? list(last.oversize) : [],
      overlaps: last ? list(last.overlaps) : [],
      review: reviewVerdict,
      research: research,
      open: open,
    });
  }

  function heal(step, signal, evidence, allowed) {
    show("diagnosing " + step);
    return diagnose(wholeRun, troubleOf(step, signal, evidence, allowed), dir, ["Goal: " + goal].concat(inputLine("")).concat(["Repository: " + repo, "Plan directory: " + dir]), STEPS[step]);
  }

  function planGateCommand() {
    return "recipe-gate plan " + quote(dir) + " --repo " + quote(repo);
  }

  function inputLine(suffix) {
    return input ? ["Input: " + input + suffix] : [];
  }

  function brief(job, extra) {
    return ["Job: implementation plan" + job + ".", "Goal: " + goal]
      .concat(inputLine(""))
      .concat(["Repository: " + repo, "Scout notes: " + scoutNotes])
      .concat([
      "Plan directory: " + dir,
      "Write " + dir + "/plan.md and one " + dir + "/tasks/<id>.md per task in the task header format; delete any file in " + dir + "/tasks/ that no longer belongs.",
      ])
      .concat(extra);
  }

  function plannerItem(key, output, lines) {
    return node(key, "planner", lines, output, { gate: planGateCommand(), big: true });
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
    if (!result.ok) return { text: what + " failed: " + (result.error || "failed"), diagnose: true };
    if (!result.structuredOutput) return { text: what + ": the plan check did not run", diagnose: false };
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

  function fromDiagnosis(d) {
    return "The diagnosis at " + d.file + " found: " + d.reason + " Follow its ## Brief section.";
  }

  function reviewItem() {
    reviews++;
    const file = reviews === 1 ? dir + "/review.md" : sibling(dir + "/review.md", String(reviews));
    return node(
      reviews === 1 ? "review" : "review-" + reviews,
      "reviewer",
      [
        "Review an implementation plan (the plan variant).",
        "Goal: " + goal,
        ...inputLine(""),
        "Repository: " + repo,
        "Plan: " + dir + "/plan.md and " + dir + "/tasks/",
        "Plan check to run: " + planGateCommand(),
        "Write the report to " + file,
      ],
      file,
      { gate: "recipe-gate verdict " + quote(file) + " --repo " + quote(repo), big: true },
    );
  }

  function review() {
    show("reviewing");
    return one(reviewItem()).then(function (result) {
      if (result.ok && !result.structuredOutput) {
        return { verdict: null, file: result.file };
      }
      if (!result.ok) {
        return heal("review", "the reviewer failed: " + (result.error || "failed"), [result.file], ["retry", "decide"]).then(function (d) {
          return d ? review() : { verdict: null, file: result.file };
        });
      }
      const verdict = result.structuredOutput.verdict;
      if (verdict !== "invalid") return { verdict: verdict, file: result.file };
      const missing = list(result.structuredOutput.missing);
      const bad = missing.length > 0;
      const why = bad ? "the review quotes text not found in the cited files: " + missing.map((m) => m.location).join(", ") : "the review's verdict could not be read";
      return heal("review", why, [result.file], bad ? ["retry", "decide"] : ["continue", "retry", "decide"]).then(function (d) {
        if (!d) return { verdict: null, file: result.file };
        if (d.action === "retry") return review();
        return { verdict: d.verdict, file: result.file };
      });
    });
  }

  function revise(job, extra) {
    revisions++;
    show("revising");
    return one(plannerItem("revise-" + revisions, dir + "/revision-" + revisions + ".md", brief(" (revision " + revisions + job + ")", ["Revise the files in place."].concat(extra))));
  }

  // One question per task that set `research`: a search, then at most
  // MAX_RESEARCH_SOURCES extracts. Nothing here is diagnosed; a task that got
  // nothing usable is an open line.
  function gather(tasks) {
    const asked = tasks.filter(function (t) {
      return t.research;
    });
    if (asked.length === 0) return Promise.resolve();
    show("researching");
    const angles = asked.map(function (t) {
      return { id: t.id, question: t.research };
    });
    const notes = [];
    return launch(
      angles.map(function (angle) {
        return searchItem(goal, angle, dir + "/research/" + angle.id + "/search.md");
      }),
    ).then(function (searches) {
      const found = sourcesFound(angles, searches, {}, notes);
      const items = [];
      const owners = [];
      asked.forEach(function (t) {
        research[t.id] = 0;
        rankAndCap(
          found.filter(function (f) {
            return f.angle === t.id;
          }),
          MAX_RESEARCH_SOURCES,
        ).forEach(function (source, k) {
          const base = dir + "/research/" + t.id;
          items.push(extractItem("extract-" + t.id + "-" + (k + 1), t.research, source.url, t.id, base + "/page-" + (k + 1) + ".md", base + "/extract-" + (k + 1) + ".md", ""));
          owners.push(t.id);
        });
      });
      return (items.length ? launch(items) : Promise.resolve([])).then(function (extracts) {
        extracts.forEach(function (r, i) {
          if (passed(r)) research[owners[i]]++;
        });
        asked.forEach(function (t) {
          if (research[t.id] > 0) return;
          const why = notes.filter(function (n) {
            return n.indexOf("search " + t.id + ": ") === 0;
          })[0];
          open.push("research for " + t.id + ": nothing usable" + (why ? " (" + why.slice(("search " + t.id + ": ").length) + ")" : ""));
        });
      });
    });
  }

  const scoutFile = dir + "/scout.md";
  const scouted = await one(
    node(
      "scout",
      "scout",
      [
        "Goal: " + goal,
        ...inputLine(" (read it first)"),
        "Repository: " + repo,
        "Find what a planner needs to split this work into tasks: the files involved and their sizes, how they relate, the repository's contributor instructions, task checks, final checks and forbidden changes, and the exact command for a task check on each kind of file involved.",
        "Output: " + scoutFile,
      ],
      scoutFile,
      { gate: "recipe-gate quotes " + quote(scoutFile) + " --repo " + quote(repo) },
    ),
  );
  let scoutNotes = "none: the scout failed, so look up the facts yourself";
  if (passed(scouted)) scoutNotes = scouted.file;
  else if (scouted.ok) open.push("scout notes rejected: " + ((scouted.structuredOutput && scouted.structuredOutput.reason) || "the quote gate did not run") + "; the planner worked without notes");
  else open.push("scout failed: " + (scouted.error || "failed") + "; the planner worked without notes");

  show("planning");
  const closing = "Closing note: one line per task, then anything you guessed.";
  let planned = await one(plannerItem("plan", dir + "/planner.md", brief("", [closing])));
  let problem = gateProblem(planned, "the planner");
  if (problem) {
    const d = problem.diagnose ? await heal("plan", problem.text, [planned.file, scoutFile], ["retry", "decide"]) : null;
    if (d) {
      show("planning");
      planned = await one(plannerItem("plan-2", dir + "/planner-2.md", brief("", [closing, "An earlier attempt did not finish. " + fromDiagnosis(d)])));
      problem = gateProblem(planned, "the planner");
    }
    if (problem) {
      open.push(problem.text);
      return finish();
    }
  }

  let lastPlanFile = planned.file;
  while (!last.ok && !onlyNoTasks(last) && revisions < MAX_REVISIONS) {
    const revised = await revise("", findingLines(last));
    problem = gateProblem(revised, "revision " + revisions);
    if (problem) {
      open.push(problem.text);
      break;
    }
    lastPlanFile = revised.file;
  }

  if (!last.ok && !onlyNoTasks(last) && !problem) {
    const d = await heal(
      "plan",
      "the plan check still fails after " + revisions + " revisions: " + problems(last).join("; "),
      [dir + "/plan.md", lastPlanFile],
      ["fix", "decide"],
    );
    if (d) {
      const revised = await revise(", from a diagnosis", [fromDiagnosis(d)].concat(findingLines(last)));
      problem = gateProblem(revised, "revision " + revisions);
      if (problem) open.push(problem.text);
    }
  }

  if (last.ok && list(last.tasks).length > 0) await gather(list(last.tasks));

  let verdict = await review();
  reviewVerdict = verdict.verdict;

  if (reviewVerdict === "needs-work") {
    const fixed = await revise(" after review", ["Address the blocking findings of the review at " + verdict.file + "; leave small findings."]);
    problem = gateProblem(fixed, "the revision after review");
    if (problem) open.push(problem.text);
    else if (last.ok) {
      verdict = await review();
      reviewVerdict = verdict.verdict;
      if (reviewVerdict === "needs-work") {
        const d = await heal("plan", "the plan still needs work after a revision for its review", [verdict.file, dir + "/plan.md"], ["fix", "decide"]);
        if (d) {
          const again = await revise(", from a diagnosis", [fromDiagnosis(d), "The latest review is " + verdict.file + "."]);
          problem = gateProblem(again, "revision " + revisions);
          if (problem) open.push(problem.text);
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

  return finish();
}
