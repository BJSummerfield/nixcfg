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
- optional `source`: `web` (default), `repo` or `both`, where a research
  question looks (`repo` is the same repository).
- optional `rounds`: change and fix runs allowed in all (default 6, at most
  10); `childTimeoutMs`, `bigTimeoutMs`.

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
<dir>/pin.md                       the pin step's marker
<dir>/reproduce.md, reproduce.log  the reproduction (verify-base.* when verify differs)
<dir>/hypotheses.md                the ranked hypotheses (hypotheses-<n>.md when a diagnosis ran it again)
<dir>/change-<rank>.md             implementer report for a hypothesis (change-<rank>-<n>.md for a fresh attempt)
<dir>/fix-<rank>-<n>.md            report of fix round n
<dir>/verify-<rank>-<n>.md         marker of the gate-only step after a fix round
<dir>/review-<rank>-<n>.md         review n of the change
<dir>/diagnosis-<subject>-<n>.md   a diagnosis
<dir>/research/h<rank>-r<n>/       the extracts of a research question
<dir>/receipt.json                 the receipt
<dir>/runner/                      the runner's status.json, board and log
```

The Claude Code binding below still writes `receipt.md` in place of `receipt.json`.

## What runs

1. A scout child carries `recipe-gate pin`, which fixes the base: the
   repository's HEAD commit and a ref to it. A pin that fails ends the run
   with an open line.
2. `reproduce`: a gate-only scout child in its own worktree of the base runs
   `recipe-gate repro --expect fail`. When `verify` differs, `verify-base`
   does the same for it. Either passing at the base ends the run.
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
     its own worktree, `recipe-gate verdict`. Clean ends the run with that
     branch as the fix. Needs-work sends the findings to the same implementer
     as a fix round, at most two reviews per hypothesis; a third is a
     `decide`.
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
   - fix round: the same implementer is resumed in its worktree with the
     findings (a resumed item cannot carry a gate), then a gate-only
     `verify-<rank>-<n>` scout child runs the same task gate with `--in` the
     worktree. Stuck detection reads that step.
   - Every change and fix run counts against `rounds`. Reaching it ends the
     run with the outcome `out of rounds` and an open line.
5. A diagnosis is a fresh reviewer (diagnosis variant), run at once for that
   hypothesis for: a stuck gate, a blocked or failed report, a child that
   failed twice, a gate that did not run, a verdict that cannot be read. It
   picks one action that `recipe-gate diagnosis` checks:
   - `fix`: one more round for the same implementer, offered only when it can
     be resumed;
   - `next`: drop this hypothesis and start the next in a fresh worktree,
     offered only when a later one exists;
   - `research`: ask one question (the first line of its `## Brief`), offered
     while fewer than two research rounds ran in the run;
   - `retry`, where the step allows it;
   - `decide`: the run stops and the question goes to the user.

   Each hypothesis gets at most two diagnoses, and the same diagnosis twice
   counts as `decide`. A hypothesis whose diagnoses are used up while a later
   one exists is dropped (`dropped: out of recoveries`) and the next starts.
6. Research: searchers (or locators, by `source`) list at most three sources
   for the question, extractors copy out the passages
   (`<dir>/research/h<rank>-r<n>/`), and the next fix round (a fresh change
   when the implementer cannot be resumed) is told to read those extracts
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
    reproduce: "<command>", verify: "<command>", check: "<command>", source: "web"
  },
  cwd: "<repo path>",
  timeoutMs: 14400000,
  maxChildren: 60
})
```

`verify`, `check` and `source` are optional. All paths are absolute. The call returns at once and this session is woken once when the run ends, so do
not poll, sleep or check on it. Then read `<dir>/receipt.json`, the whole
receipt. `recipe-status <dir>` shows progress from any shell, and
after a pi restart `recipe-run wait <dir>` waits for the end. A stopped
run continues with the same call plus `resume: true`.

```
{ base, branch, reproduction: {command, exit, signature, log}, verify, check,
  hypotheses: [{rank, claim, outcome, rounds, branch}],
  researched: [{hypothesis, question, extracts, open}],
  review, rounds_used, healed: [{id, step, action, reason}],
  decide: [{id, step, question, diagnosis}], open: [...],
  left: [{id, kind, branch, worktree}], cleanup, children }
```

`branch` is the passing attempt's own branch, null when nothing was fixed.
`review` is the clean review file. `left` holds the worktrees and branches
still in the repository, and `cleanup` is the command that removes them
(`recipe-gate abandon <dir> --keep <branch>`), empty when `left` is.

## Claude Code binding

Claude Code runs no pi-subagents workflow script, and a headless `claude -p`
runner for it has not been built. So the main session does the script's work
with the Agent tool, one `subagent_type` per role (`scout`, `reviewer`,
`implementer`, `searcher`, `locator`, `extractor`; their definitions are
installed), in the same order and with the same `recipe-gate` checks. Keep to
the limits above; nothing else stops a helper from being retried.

1. Run `recipe-gate pin <dir> --repo <repo>` and keep the `base` it prints.
2. Make a worktree of the base (`recipe-gate merge <dir>/wt/reproduce --dir
   <dir> --branch <name> --kind repro --id reproduce`) and run `recipe-gate
   repro <dir> --command '<reproduce>' --expect fail --id reproduce --in
   <worktree>`. When `verify` differs run it again with `--command
   '<verify>' --id verify-base`. Either passing ends the run.
3. Dispatch a `reviewer` (hypotheses variant) in a worktree of the base,
   writing `<dir>/hypotheses.md`, and run `recipe-gate hypotheses` on it.
4. Per hypothesis in rank order, dispatch an `implementer` (investigate
   variant) in a worktree of the base, and run `recipe-gate task <report>
   --verify '<verify>' [--check '<check>'] --repo <repo> --base <base> --run
   <dir> --id h<rank>` in that worktree. Keep the `signature` of every
   failing run per hypothesis (the reproduction's first when verify is the
   reproduce command); a repeated signature is stuck and goes to a diagnosis.
   A new one is a fix round: send the findings to the same implementer
   (SendMessage to its agent id), with no gate, then run the task gate by
   hand with `--in <worktree>`. A clean gate goes to a fresh `reviewer` (diff
   variant) in its own worktree, `recipe-gate verdict <file> --run <dir> --id
   h<rank>`. At most two reviews per hypothesis, and at most `rounds` change
   and fix runs in all.
5. Where the pi script diagnoses (step 5 of What runs), dispatch a fresh
   `reviewer` (diagnosis variant) with the step, what went wrong, the evidence
   files, the allowed actions and `<dir>/diagnosis-<subject>-<n>.md`, read it
   with `recipe-gate diagnosis <file> --allow <actions>`, and act on it with
   the same limits. For `research` dispatch `searcher` (or `locator`) and
   `extractor` children for the question, at most three sources, writing under
   `<dir>/research/h<rank>-r<n>/`, and tell the next round to read the
   extracts. Do not decide in its place: a `decide` goes to the user.
6. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched.

## What to tell the user

The branch first, or that there is none. Then the reproduction (the command
and how it failed), one line per hypothesis (claim and outcome), what was
researched (each question and whether it found anything), each `decide`
question with its diagnosis file, each `open` line, and what healed in one
line each. Report `left` and the `cleanup` command; do not run it, because
the user may want those worktrees. Do not push, open a pull request or merge
unasked, and do not answer a `decide` question for the user.
