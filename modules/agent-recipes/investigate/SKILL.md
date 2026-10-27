---
name: investigate
description: Find the cause of a bug or unexplained behaviour: a command that fails at the base is reproduced, two ranked hypotheses are tested one at a time in worktrees, a round that repeats an earlier failure goes to a diagnosis that may ask a research question, and the receipt says what reproduced, what each hypothesis came to and which branch holds the fix, all run by a script. Use only when the user asks for an investigation.
disable-model-invocation: true
---

# Investigate

Parameters, from the request:

- goal: the failure or the unexplained behaviour, in one or two sentences.
- repo: absolute path of the repository. Its checkout must have a clean
  working tree, because the runner refuses to make worktrees from a dirty
  source checkout. The branch is the deliverable, so the repository is
  required even when the failure is on a live system.
- reproduce: a shell command that fails at the base commit. If it passes
  there, or times out (10 minutes), the run ends with an open line; only a
  person can supply a failing command.
- optional `verify`: the shell command that decides whether a change fixed
  the failure; default `reproduce`. When it differs, it must also fail at the
  base, or the run ends with an open line.
- optional `check`: a light check run after the verify command on every
  attempt.

The task directory `dir` is `$TMPDIR/pi-plans/<slug>/` and may be cleaned up
at any time. It must sit outside the repository.

## Live systems

Both commands run with `sh -c` in a worktree: `reproduce` in a worktree of
the base, `verify` in the attempt's worktree. A command that never looks at
the checkout (`curl`, `systemctl is-active`, a log grep) behaves the same
anywhere. No recipe child may deploy, so when a fix can only be seen after a
deploy, pass a separate `verify` that checks the branch (an eval or a unit
test) while `reproduce` probes the live system.

The commands run more than once and appear in the children's prompts, so
each must be safe to repeat and must not hold a secret.

## What the run writes

```
<dir>/run.json                     the ledger: base commit and ref, every worktree and branch made
<dir>/reproduce.md, reproduce.log  the reproduction (verify-base.log when verify differs)
<dir>/hypotheses.md                the ranked hypotheses (hypotheses-<n>.md when a diagnosis ran it again)
<dir>/change-<rank>.md             implementer report for a hypothesis (change-<rank>-<n>.md for a fix round or a relay)
<dir>/split/h<rank>-<n>/           a split: planner.md, plan.md and the tasks of its pieces
<dir>/piece-<piece id>.md          report of one piece (piece-<piece id>-<n>.md when it was relayed or retried)
<dir>/review-<rank>-<n>.md         review n of the change
<dir>/diagnosis-<subject>-<n>.md   a diagnosis
<dir>/research/h<rank>-r<n>/       the extracts of a research question
<dir>/receipt.json                 the receipt
<dir>/runner/                      the runner's status.json, board and log
```

## What runs

1. `pin` is a gate-only step: the runner runs `recipe-gate pin` itself, with
   no child, to fix the base: the repository's HEAD commit and a ref to it.
   A pin that fails ends the run with an open line.
2. `reproduce` is a gate-only step the runner runs without a child, in its own
   worktree of the base, as `recipe-gate repro --expect fail`. When `verify`
   differs, `verify-base` does the same for it. Either passing at the base
   ends the run.
3. `hypothesize`: a reviewer (hypotheses variant) in its own worktree of the
   base reads and runs commands, edits nothing, and writes at least two
   ranked hypotheses, each with a claim and a first check
   (`recipe-gate hypotheses`); the top two are used. A failed child or gate
   goes to a diagnosis (`retry` or `decide`).
4. Hypotheses are taken in rank order, one at a time:
   - change: an implementer (investigate variant) in a fresh worktree of the
     base tests the hypothesis, commits and writes its report.
     `recipe-gate task --verify` runs the verify command (and `--check`) and
     reports a failure `signature`.
   - A gate that is ok goes to a review: a fresh reviewer (diff variant) in
     its own worktree, gated by `recipe-gate findings`, which re-runs the
     review's reproductions against the verify command (and the light check)
     in the review worktree. Clean ends the run with that branch as the fix.
     Reproduced findings go to a fresh implementer as a fix round, with the
     command or patch and its output; unreproduced ones go as advice. At most
     two reviews per hypothesis; a third is a `decide`.
   - A report `blocked: hypothesis refuted: ...` marks the hypothesis
     `refuted` and moves to the next, without a diagnosis.
   - Stuck rule, decided by code: every failing gate carries a signature, a
     hash of the normalised output of the command that failed (hex runs,
     store paths, worktree and temp paths and long digit runs are masked).
     The run keeps the signatures each hypothesis has produced, seeded with
     the reproduction's own when verify is the reproduce command. A failing
     gate with a new signature is a fix round; with a signature already seen
     it is stuck and goes to a diagnosis. A change that left the failure
     untouched is therefore diagnosed at once.
   - fix round: a fresh implementer starts in a new worktree of the
     hypothesis branch (`change-<rank>-<n>`) with the findings and runs the
     task gate itself. Stuck detection reads its gate.
   - handoff: an implementer that reaches its context budget stops and
     writes a note whose first line starts `handoff:`; the task gate reports
     it as status `handoff` with the branch, head and commit count, for a
     fix round as for the first change. The first handoff is relayed: a fresh
     implementer starts on `refs/heads/<branch>` of the one that handed off,
     told to read the note and not redo the committed work. It is then decided by code whether the next handoff
     is relayed or split: a split follows when the relay committed nothing
     (same head), spent over half its budget loading context, or a task has
     been relayed twice. The same remainder line twice, or a need for a
     third split, ends in a `decide`.
   - split: a planner (plan variant) reads the branch and the note and writes
     two or more independent pieces in `<dir>/split/h<rank>-<n>/`, checked by
     `recipe-gate plan --repo <worktree>` at half the handed-off child's
     budget (50000 tokens when it had none), each piece estimated smaller than
     that budget. A plan that does not hold up is a `decide`. The pieces run
     one after another, each in a fresh worktree of the previous piece's branch,
     with its own `recipe-gate task --check --owns --base <previous head>`.
     A piece that hands off is relayed once or twice; one that commits nothing
     before handing off, or would need a second split, is a `decide`. After
     the last piece the hypothesis takes that branch, goes to `verify` (the
     verify command and the light check on the whole result) and then to one
   review of the whole diff from the pinned base.
   - Every change, fix, relay and piece run counts toward the limit of 6 in all. Reaching
     it ends the run with the outcome `out of rounds` and an open line.
5. A diagnosis is a fresh reviewer (diagnosis variant), run at once for that
   hypothesis for: a stuck gate, a blocked or failed report, a child that
   failed twice, a piece that failed, a review that gave no verdict. It
   picks one action that `recipe-gate diagnosis` checks:
   - `fix`: one more round with a fresh implementer on the hypothesis branch;
   - `next`: drop this hypothesis and start the next in a fresh worktree,
     offered only when a later one exists;
   - `research`: ask one question (the first line of its `## Brief`), offered
     while fewer than two research rounds ran in the run;
   - `retry`, where the step allows it;
   - `decide`: the run stops and the question goes to the user.

   A gate that did not run is not diagnosed: after one mechanical rerun it
   becomes an open line and the hypothesis stops.

   Each hypothesis gets at most two diagnoses, and the same diagnosis twice
   counts as `decide`. A hypothesis whose diagnoses are used up while a later
   one exists is dropped (`dropped: out of recoveries`) and the next starts.
6. Research: searchers list at most three sources
   for the question, extractors copy out the passages
   (`<dir>/research/h<rank>-r<n>/`), and the next fix round is told to read those extracts
   before editing.
7. Every hypothesis ends as `fixed`, `refuted`, `dropped`, `out of rounds` or
   `needs a decision`. When none led to a clean change and nothing else
   asked for a decision, the run ends with a `decide`.
8. At each step the script emits a board (rounds used, each hypothesis's
   outcome and next step, what healed, what needs a decision);
   `recipe-status <dir>` prints it with the children still running.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
recipe_run({
  recipe: "investigate",
  args: {
    dir: "<dir>", goal: "<goal>", repo: "<repo path>",
    reproduce: "<command>", verify: "<command>", check: "<command>"
  },
  cwd: "<repo path>",
  timeoutMs: 14400000
})
```

`verify` and `check` are optional. All paths are absolute. The call returns at once and this session is woken once when the run ends, so do
not poll, sleep or check on it. Then read `<dir>/receipt.json`, the whole
receipt. `recipe-status <dir>` shows progress from any shell, and
after a pi restart `recipe-run wait <dir>` waits for the end. A stopped
run continues with the same call plus `resume: true`.

```
{ base, branch, reproduction: {command, exit, signature, log}, verify, check,
  hypotheses: [{rank, claim, outcome, rounds, branch, relays, splits}],
  researched: [{hypothesis, question, extracts, open}],
  review, rounds_used, healed: [{id, step, action, reason}],
  decide: [{id, step, question, diagnosis}], open: [...],
  left: [{id, kind, branch, worktree}], cleanup, children }
```

`branch` is the passing attempt's own branch (the last piece's after a split),
null when nothing was fixed. `left` names the branches of children that
handed off with kind `relay` and of split pieces with kind `piece`.
`review` is the clean review file. `left` holds the worktrees and branches
still in the repository, and `cleanup` is the command that removes them
(`recipe-gate abandon <dir> --keep <branch>`), empty when `left` is.

## Claude Code binding

The same graph runs with Claude Code children; this session only starts it and
reads the result.

```
recipe-run start investigate --harness claude --cwd <repo path> --args '{"dir":"<dir>","goal":"<goal>","repo":"<repo path>","reproduce":"<command>","verify":"<command>","check":"<command>"}' --timeout-ms 14400000
```

All paths are absolute. It returns at once. Then run `recipe-run wait <dir> --timeout-ms 7000000`
with Bash in the background and a Bash timeout of 7200000. Exit 3 means the
wait timed out while the run is still going: run the same wait again. On exit 0
or 1 read `<dir>/receipt.json`, the
whole receipt, and report as in the pi binding. `verify` and `check` are optional. `recipe-status <dir>`
shows progress from any shell. A stopped run continues with `recipe-run resume
<dir> --detach`.

## What to tell the user

The branch first, or that there is none. Then the reproduction (the command
and how it failed), one line per hypothesis (claim and outcome), what was
researched (each question and whether it found anything), each `decide`
question with its diagnosis file, each `open` line, and what healed in one
line each. Report `left` and the `cleanup` command; do not run it, because
the user may want those worktrees. Do not push, open a pull request or merge
unasked, and do not answer a `decide` question for the user.
