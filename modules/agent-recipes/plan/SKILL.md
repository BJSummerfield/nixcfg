---
name: plan
description: Turn a goal and an input file (a research summary, an idea note) into a plan directory of sized, disjoint tasks: a scout gathers repository facts, a planner writes plan.md and one file per task, a script checks sizes and file ownership, and a fresh reviewer checks the result. Use only when the user asks for a plan.
disable-model-invocation: true
---

# Plan

Parameters, from the request:

- goal: what the plan must achieve, in one or two sentences.
- input: absolute path of the file the plan starts from. Without one, write
  the user's description to `<task dir>/input.md` and use that. Optional when
  `batch` is given.
- optional `batch`: `{rule: "<glob|grep|list> <value>", change: "<description>"}`.
  It makes the planner run its batch job: the brief says `Job: batch.` and adds
  `Targets: <rule>` and `Change: <change>` after the goal; revisions keep the
  job. With no `input` the Input line is left out. On Claude, dispatch
  `planner` for the batch job with the same lines.
- repo: absolute path of the repository the tasks change.
- optional `locate`: a question naming what to find in the repository, for
  example "which files implement X?". It makes a locator run before the scout.
- optional limits: `limit` (estimate ceiling per task, default 100000
  tokens), `sizing` (a sizing file, default
  `~/.pi/agent/recipes/sizing.json`), `childTimeoutMs`, `bigTimeoutMs`.

The task directory is `$TMPDIR/pi-plans/<slug>/` and may be cleaned up at any
time. It is the plan directory the implement skill reads:

```
<dir>/plan.md        problem in one paragraph, approach, tasks in merge order,
                     heavy checks to run once at the end, changes the plan
                     avoids, open risks
<dir>/tasks/<id>.md  one per task
<dir>/locate.md      candidate files and line ranges, when `locate` was given
<dir>/research/<id>/ extract-<k>.md and page-<k>.md for a task that asked
<dir>/receipt.json   the receipt
<dir>/runner/        the runner's status.json, board and log
```

A task file opens with a header, one `key: value` per line, then a blank line
and the body (what to change and why, acceptance):

```
id: <id>             letters, digits, - or _; the file name without .md
owns: a, b           repository paths the task may change; at least one
reads: c, d          repository paths it must read, or none
check: <command>     one light check from the repository's AGENTS.md
depends: x, y        ids of tasks that must merge first, or none
research: <question>  one question a web searcher can answer, or none; optional
```

`recipe-gate plan <dir>` reads that header. `research` is for an unfamiliar API,
library or version-specific behaviour the task touches. The run also leaves `scout.md`,
`planner.md`, `review.md`, `revision-<n>.md` (numbered across the run) and
`diagnosis-<n>.md`; a retried or re-run child writes beside the file it
replaces (`<name>.retry.md`, `planner-2.md`, `review.2.md`), never over it.
`plan.md` and `tasks/` are rewritten in place by revisions.

## What runs

0. When `locate` is given, one locator answers it and writes `locate.md`
   (checked with `recipe-gate paths`). On a pass the scout is told to read it
   first and the planner gets it listed after the scout notes; on a failure
   the run records one `open` line and the scout works as before.
1. One scout reads the input and the repository and writes `scout.md`: the
   files involved, the repository's checks and forbidden changes.
2. A planner reads the input and the scout notes and writes `plan.md` and the
   task files.
3. `recipe-gate plan` sizes every task from the implementer entry of
   the sizing file (`base + k_read x (owned and read bytes) / 4 +
   growth_p90`; a file the task will create counts 0). The plan is accepted
   when no task is over the limit, no two tasks own the same file, every
   dependency exists and none loops, and every task has a check.
4. If not, the planner revises once with the check's findings (split an
   oversize task along its owned files, reassign ownership, fix cycles and
   missing fields), at most twice.
5. When the plan check passes, each task with a `research` question gets one
   searcher (writing `research/<id>/search.md`) and, for at most 3 of the
   sources it found, one extractor each, writing
   `research/<id>/extract-<k>.md` from `research/<id>/page-<k>.md`, under the
   same gates and caps as the research skill. An extract over the cap is not
   counted, and the receipt's `research` count shows what the task got. The
   extracts are not added to the task's `reads`, because the run cannot edit
   task files; the implementer is pointed at the directory instead (at most 3
   extracts of 24 KB each per task). This step never diagnoses: a task that asked and got no usable
   extract is an `open` line.
6. A fresh reviewer (plan variant) checks the plan against the goal and the
   input (`recipe-gate verdict`). On needs-work the planner revises once with
   the review and the plan is re-checked and re-reviewed once.
7. A child that fails by itself is retried once; a plan with no tasks by
   design is not revised. Whatever the script still cannot accept goes to a
   diagnose child (a fresh reviewer, diagnosis variant) at once: a planner or
   reviewer that failed twice, a verdict that cannot be read, a plan check
   still failing after two revisions, a plan still needing work after its
   revision for the review. It reads the evidence and picks one action that
   `recipe-gate diagnosis` checks against the actions allowed there:
   `continue` (a verdict that is plain but in the wrong place), `retry`,
   `fix` (one more revision with its brief) or `decide`. The run gets at
   most two diagnoses, and the same diagnosis twice counts as `decide`. A
   `decide` goes in the receipt as a question for the user.
8. At each stage the script emits a board (stage, task count, whether the
   plan check passes, the review verdict, what healed, what needs a decision);
   `recipe-status <task dir>` prints it with the children still running.

The default limit of 100000 tokens is under half of the 221184-token window,
so a task that is estimated at the limit still has the rest of the window for
the edits and check output the estimate does not cover.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
recipe_run({
  recipe: "plan",
  args: { dir: "<task dir>", goal: "<goal>", input: "<input path>", batch: { rule: "<glob|grep|list ...>", change: "<change>" }, repo: "<repo path>" },
  timeoutMs: 5400000,
  maxChildren: 30
})
```

All paths are absolute. The call returns at once and this session is woken once when the run ends, so do
not poll, sleep or check on it. Then read `<task dir>/receipt.json`, the whole
receipt. `recipe-status <task dir>` shows progress from any shell, and
after a pi restart `recipe-run wait <task dir>` waits for the end. A stopped
run continues with the same call plus `resume: true`.

```
{ plan_dir, tasks, oversize: [...], overlaps: [...], review,
  research: { <task id>: <extracts that passed> },
  healed: [{id, step, action, reason}], decide: [{id, step, question, diagnosis}],
  open: [...], children }
```

`id` is null for the whole run. `review` is `clean`, `needs-work`, or null when no verdict could be had.

Tell the user the plan directory first, then the task count, `review`, each
`decide` question with its diagnosis file, what healed in one line each, and
each `open` line. Do not start the implementation unasked, and do not answer
a `decide` question for the user.

## Claude Code binding

Claude Code runs no pi-subagents workflow script: its Workflow tool has a different
child API and must be opted into per run, and a headless `claude -p` runner for
the same script has not been built. So the main session does the script's work
with the Agent tool, one `subagent_type` per role (`scout`, `planner`,
`reviewer`; their definitions are installed), in the same order and with the
same `recipe-gate` checks. Turns in the starting session are unavoidable
here, and nothing stops a helper from being retried more than once; keep to
the limits below.

0. When `locate` is given, dispatch `locator` first with the question and
   the repository, writing `<dir>/locate.md`, and check it with
   `recipe-gate paths`. On a pass, tell the scout to read it first and list
   it for the planner; on a failure note an open line and go on.
1. Dispatch `scout` with the goal, the input, the repository and the questions
   in step 1 above, writing `<dir>/scout.md`. If it fails, retry once; if it
   fails again, plan without notes.
2. Dispatch `planner` for the implementation plan job (the batch job when
   `batch` was given, with its `Targets:` and `Change:` lines) with the goal, input,
   repository, scout notes and plan directory, telling it to write `plan.md`
   and `tasks/<id>.md` in the format above and to run `recipe-gate plan <dir>
   --repo <repo>` before it finishes.
3. Run `recipe-gate plan <dir> --repo <repo>` yourself. When `ok` is false,
   dispatch `planner` again with the JSON findings, up to twice, then record
   what is still wrong. An empty plan with `missing: ["no tasks"]` and a
   reason in `plan.md` is not revised.
4. For each task whose `research` is set, dispatch `searcher` with the
   question, writing `<dir>/research/<id>/search.md`, check it with
   `recipe-gate urls`, keep at most 3 sources for the task (primary sources
   first), and dispatch `extractor` per source writing
   `<dir>/research/<id>/extract-<k>.md` from `page-<k>.md`, checked with
   `recipe-gate extract`. Record the count that passed; a task with none
   is an open line.
5. Dispatch a fresh `reviewer` (plan variant) with the goal, input, repository,
   scout notes, plan directory and the gate command, writing `<dir>/review.md`
   (the second review `<dir>/review.2.md`); read its verdict with `recipe-gate
   verdict`. On needs-work, dispatch `planner` once with the review, re-run
   the plan gate and review once more.
6. Where the pi script diagnoses (step 7 of What runs), dispatch a fresh
   `reviewer` (diagnosis variant) with the step, what went wrong, the
   evidence files, the allowed actions and `<dir>/diagnosis-<n>.md`, read it
   with `recipe-gate diagnosis <file> --allow <actions>`, and act on it with
   the same limits. Do not decide in its place: a `decide` goes to the user.
7. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched, and report as in the pi binding.

What differs from pi: the main session spends turns on every step and
re-reads its own conversation after each helper returns; the reviewer is
fresh but runs under the same session's orchestration; there is no spawn cap
or timeout enforced for you.
