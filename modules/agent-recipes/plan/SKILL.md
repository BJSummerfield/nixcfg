---
name: plan
description: Turn a goal and an input file (a research summary, an idea note) into a plan directory of sized, disjoint tasks: a scout gathers repository facts, a planner writes plan.md and one file per task, a script checks sizes and file ownership, and a fresh reviewer checks the result. Use only when the user asks for a plan.
disable-model-invocation: true
---

# Plan

Parameters, from the request:

- goal: what the plan must achieve, in one or two sentences.
- input: absolute path of the file the plan starts from. Without one, write
  the user's description to `<task dir>/input.md` and use that.
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
<dir>/receipt.md     the receipt
```

A task file opens with a header, one `key: value` per line, then a blank line
and the body (what to change and why, acceptance):

```
id: <id>             letters, digits, - or _; the file name without .md
owns: a, b           repository paths the task may change; at least one
reads: c, d          repository paths it must read, or none
check: <command>     one light check from the repository's AGENTS.md
depends: x, y        ids of tasks that must merge first, or none
thinking: medium     or xhigh
```

`recipe-gate plan <dir>` reads that header. The run also leaves `scout.md`,
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
5. A fresh reviewer (plan variant) checks the plan against the goal and the
   input (`recipe-gate verdict`). On needs-work the planner revises once with
   the review and the plan is re-checked and re-reviewed once.
6. A child that fails by itself is retried once; a plan with no tasks by
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
7. At each stage the script emits a board (stage, task count, whether the
   plan check passes, the review verdict, what healed, what needs a decision);
   `recipe-status <task dir>` prints it with the children still running.

The default limit of 100000 tokens is under half of the 221184-token window,
so a task that is estimated at the limit still has the rest of the window for
the edits and check output the estimate does not cover.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
subagent({
  workflow: "/home/agent/.pi/agent/recipes/plan/workflow.js",
  args: { dir: "<task dir>", goal: "<goal>", input: "<input path>", repo: "<repo path>" },
  async: true,
  output: "<task dir>/receipt.md",
  options: { timeoutMs: 5400000, maxSubagentSpawnsPerRun: 30 }
})
```

All paths are absolute. Wait for the single completion with `bg_wait`; do not
poll, steer or read intermediate files. Then read only the receipt,
`<task dir>/receipt.md`.

The receipt file is a one-line summary whose Return part is the receipt JSON
cut at 1,000 characters; the summary names the run's `status.json`, whose
`workflow.value` holds the whole receipt.

```
{ plan_dir, tasks, oversize: [...], overlaps: [...], review,
  healed: [{step, action, reason}], decide: [{step, question, diagnosis}],
  open: [...], children }
```

`review` is `clean`, `needs-work`, or null when no verdict could be had.
A child that fails inside the workflow can wake this session once with a
"Workflow child failed" notice, even though the script retries it. Ignore the
notice and keep waiting for the workflow's own completion.

A child can also ask this session a question with a supervisor request while
the run goes on. Do not answer the question itself: the script decides what
happens to a stuck child. Reply that it should stop and write `blocked:` and
its question as the first line of its report, then keep waiting.

Tell the user the plan directory first, then the task count, `review`, each
`decide` question with its diagnosis file, what healed in one line each, and
each `open` line. Do not start the implementation unasked, and do not answer
a `decide` question for the user.

## Claude Code binding

Claude Code has no workflow engine, so the main session does the script's work
with the Agent tool, one `subagent_type` per role (`scout`, `planner`,
`reviewer`; their definitions are installed), in the same order and with the
same `recipe-gate` checks. Turns in the starting session are unavoidable
here, and nothing stops a helper from being retried more than once; keep to
the limits below.

1. Dispatch `scout` with the goal, the input, the repository and the questions
   in step 1 above, writing `<dir>/scout.md`. If it fails, retry once; if it
   fails again, plan without notes.
2. Dispatch `planner` for the implementation plan job with the goal, input,
   repository, scout notes and plan directory, telling it to write `plan.md`
   and `tasks/<id>.md` in the format above and to run `recipe-gate plan <dir>
   --repo <repo>` before it finishes.
3. Run `recipe-gate plan <dir> --repo <repo>` yourself. When `ok` is false,
   dispatch `planner` again with the JSON findings, up to twice, then record
   what is still wrong. An empty plan with `missing: ["no tasks"]` and a
   reason in `plan.md` is not revised.
4. Dispatch a fresh `reviewer` (plan variant) with the goal, input, repository,
   scout notes, plan directory and the gate command, writing `<dir>/review.md`
   (the second review `<dir>/review.2.md`); read its verdict with `recipe-gate
   verdict`. On needs-work, dispatch `planner` once with the review, re-run
   the plan gate and review once more.
5. Where the pi script diagnoses (step 6 of What runs), dispatch a fresh
   `reviewer` (diagnosis variant) with the step, what went wrong, the
   evidence files, the allowed actions and `<dir>/diagnosis-<n>.md`, read it
   with `recipe-gate diagnosis <file> --allow <actions>`, and act on it with
   the same limits. Do not decide in its place: a `decide` goes to the user.
6. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched, and report as in the pi binding.

What differs from pi: the main session spends turns on every step and
re-reads its own conversation after each helper returns; the reviewer is
fresh but runs under the same session's orchestration; there is no spawn cap
or timeout enforced for you.
