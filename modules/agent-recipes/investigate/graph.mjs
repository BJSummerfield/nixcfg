import { recipeLib } from "../lib/recipe-lib.mjs";

export default async function investigate(args, port) {
const { quote, list, short, node, gateOnly, one, subjectOf, troubleOf, exhausted, askDecision, diagnose, board, receipt, gatherSources, handoffLimits, handedOff, handoffTrack, beginRelay, clearRelay, relayBriefLines, stampRelay, reportHandoff, handoffCall, acceptSplit, splitPlanItem } = recipeLib(port);

const MAX_RESEARCH = 2;
const MAX_REVIEWS = 2;
const REPRO_GATE_MS = 660000;
const TASK_GATE_MS = 1260000;
const PLAN_GATE_LIMIT = 100000;
const FINDINGS_GATE_MS = 6600000;
const MAX_ROUNDS = 6;

const dir = args.dir;
const goal = args.goal;
const repo = args.repo;
const reproduce = args.reproduce;
const verifyCommand = args.verify || reproduce;
const lightCheck = args.check || "";

const STEPS = {
  hypothesize: "the ranking of hypotheses for the failure",
  change: "the implementer's test of one hypothesis (its report and the verify command run in its worktree)",
  verify: "the task gate, run on the worktree after the last piece of a split",
  piece: "one piece of a task that was split after its implementer handed off",
  review: "the review of the change's diff",
};

const open = [];
const made = [];
const researched = [];
const hyps = [];
const wholeRun = subjectOf(null);
let pinned = null;
let reproduction = null;
let baseSignature = null;
let roundsUsed = 0;
let researchRounds = 0;
let winner = null;
let hypothesesFile = dir + "/hypotheses.md";
const pieceIds = [];
let ended = false;

function noteMade(id, kind, entryBranch, entryWorktree) {
  if (!entryBranch && !entryWorktree) return;
  const duplicate = made.some(function (m) {
    return m.kind === kind && m.branch === (entryBranch || null) && m.worktree === (entryWorktree || null);
  });
  if (!duplicate) made.push({ id: id, kind: kind, branch: entryBranch || null, worktree: entryWorktree || null });
}

function view() {
  return {
    rounds_used: roundsUsed,
    hypotheses: hyps.map(function (h) {
      return { rank: h.rank, outcome: h.outcome, next: h.next, relays: h.track.relays, splits: h.track.root.splits };
    }),
  };
}

function finish() {
  const left = made.slice();
  const branch = winner ? winner.branch : null;
  return receipt({
    base: pinned ? pinned.base : null,
    branch: branch,
    reproduction: reproduction,
    verify: verifyCommand || null,
    check: lightCheck || null,
    hypotheses: hyps.map(function (h) {
      return { rank: h.rank, claim: h.claim, outcome: h.outcome, rounds: h.rounds, branch: h.branch, relays: h.track.relays, splits: h.track.root.splits };
    }),
    researched: researched,
    review: winner ? winner.cleanReview : null,
    rounds_used: roundsUsed,
    open: open,
    left: left,
    cleanup: left.length ? "recipe-gate abandon " + quote(dir) + (branch ? " --keep " + quote(branch) : "") : "",
  });
}

function reproItem(key, command) {
  return gateOnly(key, "recipe-gate repro " + quote(dir) + " --command " + quote(command) + " --expect fail --id " + quote(key), {
    worktree: true,
    baseRef: pinned.base_ref,
    gateTimeoutMs: REPRO_GATE_MS,
  });
}

function reproLine() {
  return "Reproduction: " + reproduce + " failed with exit " + reproduction.exit + " at the base; its output is in " + reproduction.log;
}

function commandLines() {
  const lines = ["Verify command: " + verifyCommand];
  if (lightCheck) lines.push("Task check: " + lightCheck);
  return lines;
}

function hasLater(h) {
  return hyps.indexOf(h) < hyps.length - 1;
}

function allowedFor(h, withFix) {
  const allowed = [];
  if (withFix) allowed.push("fix");
  if (hasLater(h)) allowed.push("next");
  if (researchRounds < MAX_RESEARCH) allowed.push("research");
  allowed.push("decide");
  return allowed;
}

function stopHere(h, outcome) {
  h.outcome = outcome;
  h.next = null;
  h.finished = true;
}

function askPerson(h, step, question, file) {
  askDecision(h.subject, step, question, file);
  stopHere(h, "needs a decision");
  ended = true;
}

function heal(h, step, signal, evidence, allowed) {
  const trouble = troubleOf(step, signal, evidence, allowed);
  if (exhausted(h.subject) && hasLater(h)) {
    stopHere(h, "dropped: out of recoveries");
    return;
  }
  h.next = "diagnose";
  h.trouble = trouble;
}

function outOfRounds(h) {
  open.push("out of rounds: " + MAX_ROUNDS + " change runs used");
  stopHere(h, "out of rounds");
  ended = true;
}

function taskGate(h, report, inDir) {
  const parts = ["recipe-gate task", quote(report), "--verify", quote(verifyCommand)];
  if (lightCheck) parts.push("--check", quote(lightCheck));
  parts.push("--repo", quote(repo), "--base", quote(pinned.base), "--run", quote(dir), "--id", quote("h" + h.rank));
  if (inDir) parts.push("--in", quote(inDir));
  return parts.join(" ");
}

function takeNotes(h) {
  const lines = h.notes;
  h.notes = [];
  return lines;
}

function changeItem(h) {
  h.attempts++;
  h.rounds++;
  roundsUsed++;
  const tag = h.rank + (h.attempts === 1 ? "" : "-" + h.attempts);
  const report = dir + "/change-" + tag + ".md";
  h.report = report;
  h.briefNotes = takeNotes(h);
  const lines = ["Job: test one hypothesis (the investigate variant).", "Goal: " + goal, "Hypothesis " + h.rank + ": " + h.claim, "Check first: " + h.check, reproLine()]
    .concat(commandLines())
    .concat(["Repository: " + repo + " (you are in your own worktree of " + (h.relayRef ? "the branch " + h.relayBranch : "the base") + ", on your own branch)"])
    .concat(relayBriefLines(h))
    .concat(h.briefNotes);
  lines.push("If the evidence refutes the hypothesis, change nothing and write `blocked: hypothesis refuted: <evidence>` as the first line of the report.");
  lines.push("Commit your work on the branch and leave nothing uncommitted.");
  lines.push("Write the report to " + report);
  const item = node("change-" + tag, "implementer", lines, report, {
    gate: taskGate(h, report),
    gateTimeoutMs: TASK_GATE_MS,
    worktree: true,
  });
  stampRelay(item, h, pinned.base_ref);
  return item;
}

function fixFindings(file, g) {
  const lines = ["The review at " + file + " showed these defects at the branch head. Each is a command run from the repository root with its exit status and output, or a patch after which the task's check still passed (the tests cannot see that behaviour); make every command exit 0 and every patch fail the check, without breaking the check."];
  let n = 0;
  if (g.check && g.check.exit !== 0) {
    lines.push(++n + ". The task's check failed at head -> exit " + g.check.exit);
    lines.push(g.check.tail);
  }
  for (const f of g.reproduced || []) {
    lines.push(++n + ". [" + f.title + "] " + f.summary + " -> exit " + f.exit);
    lines.push(f.tail);
  }
  const advice = (g.unreproduced || []).map((f) => f.title + ": " + f.summary).concat((g.unrunnable || []).map((f) => f.title + ": " + f.summary + " (" + f.reason + ")"));
  if (advice.length) lines.push("Advice from the review, not required: " + advice.join("; "));
  return lines.join("\n");
}

function queueFix(h, finding) {
  h.notes.push(finding);
  if (h.branch) beginRelay(h, null, { branch: h.branch, note: null, from: null });
  h.next = "change";
}

function verifyItem(h) {
  h.verifyTries++;
  const key = "verify-" + h.rank + (h.splitsDone ? "s" + h.splitsDone : "") + (h.verifyTries === 1 ? "" : "-" + h.verifyTries);
  return gateOnly(key, taskGate(h, h.report, h.worktree), { gateTimeoutMs: TASK_GATE_MS });
}

function reviewItem(h) {
  h.reviews++;
  const file = dir + "/review-" + h.rank + "-" + h.reviews + ".md";
  const lines = [
    "Review a diff on a branch (the diff variant).",
    "Goal: " + goal,
    "Hypothesis " + h.rank + ": " + h.claim,
    "Repository: " + repo,
    "Branch: " + h.branch,
    "Worktree: your working directory is your own worktree of the branch; read and run the verify command there and make no other worktree. The implementer's worktree " + h.worktree + " is not yours: never read or run anything in it.",
    "Diff to review: git diff " + pinned.base + ".." + h.branch,
    reproLine(),
  ].concat(commandLines());
  lines.push("Write the report to " + file);
  const item = node("review-" + h.rank + "-" + h.reviews, "reviewer", lines, file, {
    gate: "recipe-gate findings " + quote(file) + " --check " + quote(lightCheck ? verifyCommand + " && " + lightCheck : verifyCommand) + " --run " + quote(dir) + " --id " + quote("h" + h.rank),
    gateTimeoutMs: FINDINGS_GATE_MS,
    worktree: true,
    big: true,
  });
  item.baseRef = "refs/heads/" + h.branch;
  return item;
}

function pendingOf(result) {
  return {
    handoff: handedOff(result),
    firstContext: result.usage ? result.usage.firstContext : undefined,
    budget: result.budget || null,
    runId: result.runId || null,
  };
}

function handoffInfo(source, g, report) {
  if (source && source.handoff) return source;
  const handoff = reportHandoff(g, report);
  if (!handoff) return null;
  return {
    handoff: handoff,
    firstContext: undefined,
    budget: source && source.budget ? source.budget : null,
    runId: source && source.runId ? source.runId : null,
  };
}

function takeHandoff(h, g, info, step) {
  const given = info.handoff;
  if (!g.branch || !g.worktree) return heal(h, step, "the child handed off but the task has no branch", [h.report], ["retry", "decide"]);
  h.head = g.head || null;
  h.handoffFrom = info.runId;
  h.handoffInfo = { note: given.note || null, budget: info.budget };
  const call = handoffCall(h.track, given, g, { firstContext: info.firstContext, budgetTokens: info.budget ? info.budget.tokens : undefined });
  if (call.action === "decide") {
    return askPerson(h, step, "the " + step + " handed off and " + call.reason + "; the work is on " + h.branch, given.note);
  }
  if (call.action === "split") {
    h.next = "split";
    return;
  }
  beginRelay(h, h.track, { branch: h.branch, note: given.note, from: h.handoffFrom });
  h.next = "change";
}

function takeGate(h, result, step) {
  const g = result.structuredOutput;
  if (step === "change" && !result.ok && !(g && g.report)) {
    return heal(h, step, "the implementer failed twice: " + (result.error || "failed"), [h.report], ["retry", "decide"]);
  }
  if (!g) {
    open.push("hypothesis " + h.rank + ": the task gate did not run");
    return stopHere(h, "gate did not run");
  }
  const status = g.report ? g.report.status : "invalid";
  const info = handoffInfo(pendingOf(result), g, h.report);
  const handing = Boolean(info) && (info.handoff.empty || status === "handoff");
  if (g.branch) h.branch = g.branch;
  if (g.worktree) h.worktree = g.worktree;
  noteMade("h" + h.rank, handing ? "relay" : "task", g.branch, g.worktree);
  if (handing) return takeHandoff(h, g, info, step);
  if (status === "blocked" || status === "failed") {
    const why = g.report.why || "";
    if (step === "change" && status === "blocked" && /^hypothesis refuted:/i.test(why)) {
      stopHere(h, "refuted: " + short(why.replace(/^hypothesis refuted:\s*/i, "")));
      return;
    }
    return heal(h, step, "the implementer reported " + status + ": " + g.reason, [h.report], allowedFor(h, true));
  }
  if (!g.branch || !g.worktree) return heal(h, step, g.reason || "the task has no branch", [h.report], ["retry", "decide"]);
  if (g.ok) {
    h.next = "review";
    return;
  }
  if (g.signature && h.seen.indexOf(g.signature) >= 0) {
    return heal(h, step, "the same failure came back: " + g.reason, [h.report], allowedFor(h, true));
  }
  if (g.signature) h.seen.push(g.signature);
  queueFix(h, "The task gate reported: " + g.reason);
}

function takeReview(h, result) {
  const g = result.structuredOutput;
  if (g) noteMade("h" + h.rank, "review", g.branch, g.worktree);
  if (!result.ok) {
    return heal(h, "review", "the reviewer failed: " + (result.error || "failed"), [result.file], ["retry", "decide"]);
  }
  if (!g) {
    open.push("hypothesis " + h.rank + ": the review's verdict gate did not run");
    return stopHere(h, "gate did not run");
  }
  if (g.handoff) open.push("hypothesis " + h.rank + ": review " + h.reviews + " hit the reviewer's budget: " + g.handoff);
  if (g.verdict === "clean") {
    const unrunnable = g.unrunnable || [];
    if (unrunnable.length) open.push("hypothesis " + h.rank + ": review " + h.reviews + " could not run " + unrunnable.length + " reproduction(s): " + unrunnable.map((f) => f.n + ": " + f.reason).join("; "));
    stopHere(h, "fixed");
    h.cleanReview = result.file;
    winner = h;
    ended = true;
    return;
  }
  if (g.verdict === null) {
    return heal(h, "review", "the review gave no verdict: " + g.reason, [result.file], ["retry", "decide"]);
  }
  if (h.reviews >= MAX_REVIEWS) {
    return askPerson(h, "review", "still not clean after " + MAX_REVIEWS + " reviews; see " + result.file, result.file);
  }
  queueFix(h, fixFindings(result.file, g));
}

function taskLines(h) {
  return ["Goal: " + goal, "Hypothesis " + h.rank + ": " + h.claim, reproLine()].concat(commandLines());
}

function splitItem(h) {
  h.splits++;
  const budget = h.handoffInfo.budget;
  const limit = budget && budget.tokens > 0 ? Math.floor(handoffLimits.START_FRACTION * budget.tokens) : Math.floor(handoffLimits.START_FRACTION * PLAN_GATE_LIMIT);
  const item = splitPlanItem({
    key: "split-" + h.rank + "-" + h.splits,
    splitDir: dir + "/split/h" + h.rank + "-" + h.splits,
    taskFile: hypothesesFile,
    note: h.handoffInfo.note,
    branch: h.branch,
    worktree: h.worktree,
    base: pinned.base,
    owns: [],
    parentId: "h" + h.rank,
    limit: limit,
    handoffOf: h.handoffFrom,
  });
  const text = item.task.split("\n");
  item.task = [text[0]].concat(taskLines(h), text.slice(1)).join("\n");
  return item;
}

function takeSplit(h, result) {
  const g = result.structuredOutput;
  if (!result.ok) return askPerson(h, "split", "the split plan failed: " + (result.error || "failed"), result.file);
  if (!g) {
    open.push("hypothesis " + h.rank + ": the split plan gate did not run");
    return stopHere(h, "gate did not run");
  }
  const budget = h.handoffInfo.budget;
  const found = acceptSplit(h.track, g, { parentId: "h" + h.rank, parentEst: budget ? budget.tokens : null, parentOwns: null, taken: pieceIds });
  if (!found.ok) return askPerson(h, "split", found.problem, result.file);
  found.pieces.forEach(function (p) {
    pieceIds.push(p.id);
  });
  h.pieces = found.pieces;
  h.pieceNo = 0;
  h.piece = null;
  h.prev = { branch: h.branch, worktree: h.worktree, head: h.head };
  const from = h.handoffFrom;
  clearRelay(h);
  h.handoffFrom = from;
  h.next = "piece";
}

function pieceItem(h) {
  if (!h.piece) {
    h.piece = { spec: h.pieces[h.pieceNo], track: handoffTrack(h.track), attempts: 0, relayRef: null, relayBranch: null, relayNote: null, handoffFrom: null };
  }
  const p = h.piece;
  p.attempts++;
  h.rounds++;
  roundsUsed++;
  const tag = p.spec.id + (p.attempts === 1 ? "" : "-" + p.attempts);
  const report = dir + "/piece-" + tag + ".md";
  p.report = report;
  h.report = report;
  const lines = ["Job: carry out one piece of a task that was split (the investigate variant)."]
    .concat(taskLines(h))
    .concat([
      "Piece " + p.spec.id + ", task file: " + p.spec.file,
      "Do what the task file asks and nothing beyond it; other pieces cover the rest. The verify command runs after the last piece.",
      "Repository: " + repo + " (you are in your own worktree of the branch " + (p.relayBranch || h.prev.branch) + ", on your own branch)",
    ])
    .concat(relayBriefLines(p))
    .concat(takeNotes(h));
  lines.push("Commit your work on the branch and leave nothing uncommitted.");
  lines.push("Write the report to " + report);
  const command = [
    "recipe-gate task",
    quote(report),
    "--check",
    quote(p.spec.check),
    "--owns",
    quote(list(p.spec.owns).join(",")),
    "--repo",
    quote(repo),
    "--base",
    quote(h.prev.head),
    "--run",
    quote(dir),
    "--id",
    quote("h" + h.rank + "-" + p.spec.id),
  ].join(" ");
  const item = node("piece-" + tag, "implementer", lines, report, { gate: command, gateTimeoutMs: TASK_GATE_MS, worktree: true });
  stampRelay(item, p, "refs/heads/" + h.prev.branch);
  return item;
}

function takePiece(h, result) {
  const p = h.piece;
  const g = result.structuredOutput;
  if (!result.ok && !(g && g.report)) return heal(h, "piece", "piece " + p.spec.id + " failed twice: " + (result.error || "failed"), [p.report], ["retry", "decide"]);
  if (!g) {
    open.push("hypothesis " + h.rank + ": the task gate did not run for piece " + p.spec.id);
    return stopHere(h, "gate did not run");
  }
  const status = g.report ? g.report.status : "invalid";
  const info = handoffInfo(pendingOf(result), g, p.report);
  const handing = Boolean(info) && (info.handoff.empty || status === "handoff");
  if (g.branch) noteMade("h" + h.rank + "-" + p.spec.id, "piece", g.branch, g.worktree);
  if (handing) {
    const given = info.handoff;
    if (!g.branch || !g.worktree) return heal(h, "piece", "piece " + p.spec.id + " handed off but has no branch", [p.report], ["retry", "decide"]);
    const call = handoffCall(p.track, given, g, { firstContext: info.firstContext, budgetTokens: info.budget ? info.budget.tokens : undefined });
    if (call.action !== "relay") {
      return askPerson(h, "piece", "piece " + p.spec.id + " handed off and " + (call.action === "split" ? "would need another split: " : "") + call.reason + "; the work is on " + g.branch, given.note);
    }
    beginRelay(p, p.track, { branch: g.branch, note: given.note, from: info.runId });
    h.next = "piece";
    return;
  }
  if (status === "blocked" || status === "failed") {
    return heal(h, "piece", "piece " + p.spec.id + " reported " + status + ": " + g.reason, [p.report], ["retry", "decide"]);
  }
  if (!g.ok || !g.branch || !g.worktree) return heal(h, "piece", "piece " + p.spec.id + ": " + (g.reason || "the task has no branch"), [p.report], ["retry", "decide"]);
  h.prev = { branch: g.branch, worktree: g.worktree, head: g.head };
  h.piece = null;
  h.pieceNo++;
  if (h.pieceNo < h.pieces.length) {
    h.next = "piece";
    return;
  }
  h.branch = g.branch;
  h.worktree = g.worktree;
  h.head = g.head || null;
  h.report = p.report;
  h.pieces = null;
  h.splitsDone++;
  h.verifyTries = 0;
  h.next = "verify";
}

function diagnosisContext(h) {
  const lines = ["Goal: " + goal, "Repository: " + repo];
  if (reproduction) lines.push(reproLine());
  lines.push("Verify command: " + verifyCommand);
  if (h.rank) lines.push("Hypothesis " + h.rank + ": " + h.claim);
  if (h.worktree) lines.push("Worktree: " + h.worktree + (h.branch ? " on branch " + h.branch : "") + " (read it, run checks in it, edit nothing)");
  return lines;
}

function researchLine(question, files) {
  return 'Research notes for the question "' + question + '" are in: ' + files.join(", ") + ". Read them before the next edit.";
}

function takeDiagnosis(h, d, trouble) {
  const step = trouble.step;
  if (d.action === "retry") {
    if (step === "change") h.notes = h.briefNotes.concat(h.notes);
    h.next = step;
    return Promise.resolve();
  }
  if (d.action === "next") {
    if (!hasLater(h)) return Promise.resolve(askPerson(h, step, "the diagnosis moves on, but no hypothesis is left: " + d.reason, d.file));
    stopHere(h, "dropped: " + short(d.reason));
    return Promise.resolve();
  }
  const followUp = "The diagnosis at " + d.file + " found: " + d.reason + " Follow its ## Brief section.";
  if (d.action === "fix") {
    queueFix(h, followUp);
    return Promise.resolve();
  }
  if (d.action === "research") {
    researchRounds++;
    const id = "h" + h.rank + "-r" + researchRounds;
    return gatherSources({ goal: goal, question: d.question, id: id, dir: dir, repo: repo, limit: 3 }).then(function (found) {
      researched.push({ hypothesis: h.rank, question: d.question, extracts: found.files, open: found.open });
      found.open.forEach(function (line) {
        open.push("research " + id + ": " + line);
      });
      if (found.files.length) h.notes.push(researchLine(d.question, found.files));
      queueFix(h, followUp);
    });
  }
  return Promise.resolve(askPerson(h, step, "the diagnosis chose " + d.action + ", which this recipe does not use: " + d.reason, d.file));
}

function diagnoseStep(h) {
  const trouble = h.trouble;
  h.trouble = null;
  return diagnose(h.subject, trouble, dir, diagnosisContext(h), STEPS[trouble.step]).then(function (d) {
    if (!d) {
      stopHere(h, "needs a decision");
      ended = true;
      return undefined;
    }
    return takeDiagnosis(h, d, trouble);
  });
}

function step(h) {
  if (h.next === "diagnose") return diagnoseStep(h);
  if (h.next === "review") {
    return one(reviewItem(h)).then(function (r) {
      takeReview(h, r);
    });
  }
  if (h.next === "verify") {
    return one(verifyItem(h)).then(function (r) {
      takeGate(h, r, "verify");
    });
  }
  if (roundsUsed >= MAX_ROUNDS) {
    outOfRounds(h);
    return Promise.resolve();
  }
  if (h.next === "split") {
    return one(splitItem(h)).then(function (r) {
      takeSplit(h, r);
    });
  }
  if (h.next === "piece") {
    return one(pieceItem(h)).then(function (r) {
      takePiece(h, r);
    });
  }
  return one(changeItem(h)).then(function (r) {
    takeGate(h, r, "change");
  });
}

const problems = [];
["dir", "goal", "repo", "reproduce"].forEach(function (name) {
  if (!args[name]) problems.push("the " + name + " argument is required");
});
if (problems.length) {
  problems.forEach(function (p) {
    open.push(p);
  });
  return finish();
}

const pin = await one(gateOnly("pin", "recipe-gate pin " + quote(dir) + " --repo " + quote(repo)));
if (!pin.ok || !pin.structuredOutput) {
  open.push("the base could not be pinned: " + (pin.error || "the pin did not run"));
  return finish();
}
if (!pin.structuredOutput.ok) {
  open.push("the base could not be pinned: " + pin.structuredOutput.reason);
  return finish();
}
pinned = pin.structuredOutput;

const rep = await one(reproItem("reproduce", reproduce));
const repG = rep.structuredOutput;
if (repG && rep.worktree) noteMade("reproduce", "repro", repG.branch, repG.worktree);
if (!rep.ok || !repG) {
  open.push("the reproduction did not run: " + (rep.error || "its gate did not run"));
  return finish();
}
if (!repG.ok) {
  open.push("the reproduce command did not fail at the base: " + repG.reason);
  return finish();
}
reproduction = { command: reproduce, exit: repG.exit, signature: repG.signature || null, log: repG.log };

if (verifyCommand !== reproduce) {
  const atBase = await one(reproItem("verify-base", verifyCommand));
  const baseG = atBase.structuredOutput;
  if (baseG && atBase.worktree) noteMade("verify-base", "repro", baseG.branch, baseG.worktree);
  if (!atBase.ok || !baseG) {
    open.push("the verify command could not be run at the base: " + (atBase.error || "its gate did not run"));
    return finish();
  }
  baseSignature = baseG.signature || null;
  if (!baseG.ok) {
    open.push("the verify command does not fail at the base, so it cannot tell a fix from no fix: " + baseG.reason);
    return finish();
  }
}

let found = null;
for (let attempt = 1; !found; attempt++) {
  const tag = attempt === 1 ? "" : "-" + attempt;
  const file = dir + "/hypotheses" + tag + ".md";
  const lines = [
    "Write ranked hypotheses for a failure (the hypotheses variant).",
    "Goal: " + goal,
    "Repository: " + repo,
    "Worktree: you are in a worktree of the base commit (read it and run commands in it; edit nothing)",
    reproLine(),
  ].concat(commandLines());
  lines.push("Write the hypotheses to " + file);
  const item = node("hypothesize" + tag, "reviewer", lines, file, {
    gate: "recipe-gate hypotheses " + quote(file) + " --run " + quote(dir) + " --id " + quote("hypothesize" + tag),
    worktree: true,
    big: true,
  });
  item.baseRef = pinned.base_ref;
  const r = await one(item);
  const g = r.structuredOutput;
  if (g) noteMade("hypothesize" + tag, "hypothesize", g.branch, g.worktree);
  if (r.ok && g && g.ok && list(g.hypotheses).length >= 2) {
    found = list(g.hypotheses).slice(0, 2);
    hypothesesFile = r.file || file;
  } else if (r.ok && !g) {
    open.push("the hypotheses gate did not run");
    return finish();
  } else {
    const signal = !r.ok ? "the reviewer failed: " + (r.error || "failed") : "no usable hypotheses: " + g.problem;
    const d = await diagnose(wholeRun, troubleOf("hypothesize", signal, [r.file], ["retry", "decide"]), dir, diagnosisContext({}), STEPS.hypothesize);
    if (!d) {
      open.push("no hypotheses: " + short(signal));
      return finish();
    }
  }
}

found.forEach(function (spec) {
  hyps.push({
    subject: subjectOf("h" + spec.rank),
    rank: spec.rank,
    claim: spec.claim,
    check: spec.check,
    outcome: "untried",
    next: null,
    finished: false,
    attempts: 0,
    verifyTries: 0,
    reviews: 0,
    rounds: 0,
    report: null,
    branch: null,
    worktree: null,
    cleanReview: null,
    notes: [],
    briefNotes: [],
    trouble: null,
    track: handoffTrack(),
    relayRef: null,
    relayBranch: null,
    relayNote: null,
    handoffFrom: null,
    handoffInfo: null,
    head: null,
    splits: 0,
    splitsDone: 0,
    pieces: null,
    pieceNo: 0,
    piece: null,
    prev: null,
    seen: (verifyCommand === reproduce ? reproduction.signature : baseSignature) ? [verifyCommand === reproduce ? reproduction.signature : baseSignature] : [],
  });
});

for (let i = 0; i < hyps.length && !ended; i++) {
  const h = hyps[i];
  h.next = "change";
  while (!h.finished && !ended) {
    await step(h);
    board("investigating", view());
  }
}
if (!winner && !ended) askDecision(wholeRun, "investigate", "no hypothesis led to a clean change; see the outcomes in the receipt", null);

return finish();
}
