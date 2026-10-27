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
8. A planner or reviewer that nears its budget hands off with a first line
   `handoff: ...`. A planner's handoff is not continued: what it wrote meets
   the plan check like any short plan, and a failing check goes to the
   revision in step 4. A reviewer that lists the task files it did not read
   (`unread:` lines) is continued: the library runs reviewer parts over those
   files (two halves, or one part for a single file) and one merge reviewer
   over the notes and part files, which writes `review.merged.md`; its verdict
   is the review's. A reviewer that hands off with no `unread:` list has
   failed the step: `recipe-gate verdict` reads its file as `invalid`, never
   as a verdict, and the step goes to diagnosis as in step 7.
9. At each stage the script emits a board (stage, task count, whether the
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

The same graph runs with Claude Code children; this session only starts it and
reads the result.

```
recipe-run start plan --harness claude --args '{"dir":"<task dir>","goal":"<goal>","input":"<input path>","batch":{"rule":"<glob|grep|list ...>","change":"<change>"},"repo":"<repo path>"}' --timeout-ms 5400000 --max-children 30
```

All paths are absolute. It returns at once. Then run `recipe-run wait <task dir> --timeout-ms 7000000`
with Bash in the background and a Bash timeout of 7200000. Exit 3 means the
wait timed out while the run is still going: run the same wait again. On exit 0
or 1 read `<task dir>/receipt.json`, the
whole receipt, and report as in the pi binding. `recipe-status <task dir>`
shows progress from any shell. A stopped run continues with `recipe-run resume
<task dir> --detach`.
