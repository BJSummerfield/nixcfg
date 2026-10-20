---
name: implement
description: Carry out a plan directory made by the plan skill: each task is built in its own worktree, reviewed by a fresh reviewer and fixed for at most two rounds, then the finished tasks are merged on one branch, the heavy checks run once and the pull request text is written, all run by a script. Use only when the user asks for an implementation.
disable-model-invocation: true
---

# Implement

Parameters, from the request:

- plan: absolute path of the plan directory the plan skill wrote (`plan.md`
  and `tasks/<id>.md`; the header format is in the plan skill). It must sit
  outside the repository, or the run's own files would dirty the checkout
  that every task worktree starts from.
- repo: absolute path of the repository the tasks change. Its checkout must
  have a clean working tree, because every task starts from its HEAD in a
  worktree of its own.
- optional: `branch` (name of the integration branch, default
  `implement/<name of the plan directory>`), `limit` and `sizing` (as in the
  plan skill, for the plan check), `childTimeoutMs`, `bigTimeoutMs`.

The plan directory is also the task directory. The run writes into it, next
to the plan:

```
<dir>/impl-<id>.md          implementer report; a retried one is impl-<id>.retry.md
<dir>/review-<id>-<n>.md    review n of the task
<dir>/fix-<id>-<n>.md       report of fix round n
<dir>/integration.md        report of the integration step
<dir>/integration/          worktree of the integration branch
<dir>/heavy.md              first line pass, none or fail: <why>, then the output
<dir>/pr.md                 pull request title and body
<dir>/receipt.md            the receipt
```

Task worktrees and branches are managed by the runner and live beside the
repository; every task branch stays until it is cleaned up by hand.

## What runs

1. One scout child exists only to carry the plan gate: `recipe-gate plan`
   checks sizes, file ownership, dependencies and that every task has a
   check. A gate runs only after a child, and this child is the cheapest one;
   the plan check, not the child, decides. A plan that is not ok is refused
   with the check's findings in the receipt, before any worktree exists.
2. Tasks are ordered by `depends` into waves. A task runs once everything it
   depends on has finished; a task whose dependency was set aside or skipped
   is skipped. Within a wave the tasks run in parallel, three at a time at
   most.
3. Each task: an implementer in a worktree of its own, with the thinking level
   of the task header, merges the branches of its dependencies, makes its
   change, commits it and writes its report. `recipe-gate task` then runs in
   that worktree and reports the branch, the commits, the files changed
   outside `owns`, whether anything is uncommitted and the result of the
   task's check run once more. A report that says `blocked` or `failed` sets
   the task aside at once.
4. A fresh reviewer (diff variant) reads the branch's own diff, runs the check
   in the worktree and gives a verdict (`recipe-gate verdict`). On needs-work,
   or when the task gate was red, the same implementer is resumed in the same
   worktree with the findings and fixes them in new commits; then a fresh
   review. At most two fix rounds; a task still not clean is set aside with
   its reason. Other tasks go on.
5. One implementer with a brief (no worktree of its own) creates the
   integration branch and worktree from the repository's current HEAD with
   `git worktree add`, so the checkout does not move, merges the finished
   branches in the plan's order, runs the plan's heavy checks once under the
   box-wide lock, and writes `pr.md` and `heavy.md`. `recipe-gate integrate`
   then confirms every finished branch is in the branch, nothing is
   uncommitted, `pr.md` is not empty and the heavy checks passed or were not
   needed. It never merges into the main branch and never pushes.
6. A child that fails by itself is retried once (a fix round is resumed again
   from the failed run); a task whose child fails twice is set aside.

The pi mechanism behind steps 3 and 4: a workflow child with `worktree: true`
gets a managed worktree on its own branch; because it is a workflow child with
a session, the runner keeps that worktree and branch instead of removing them
after capturing the patch, so the child can be resumed in it
(`runs.run` with `resume: <runId>`). The script learns the branch and worktree
path from the task gate, which runs inside the child's worktree.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
subagent({
  workflow: "/home/agent/.pi/agent/recipes/implement/workflow.js",
  args: {
    plan: "<plan dir>", repo: "<repo path>", model: "@subagentModel@"
  },
  cwd: "<repo path>",
  async: true,
  output: "<plan dir>/receipt.md",
  options: { timeoutMs: 14400000, maxSubagentSpawnsPerRun: <12 x tasks + 4> }
})
```

All paths are absolute. `cwd` is the repository, so the worktrees branch from
it. `model` is only used for tasks whose header says `thinking: xhigh`.
Wait for the single completion with `bg_wait`; do not poll, steer or read
intermediate files. Then read only the receipt, `<plan dir>/receipt.md`.

The receipt file is a one-line summary whose Return part is the receipt JSON
cut at 1,000 characters; the summary names the run's `status.json`, whose
`workflow.value` holds the whole receipt.

```
{ branch, merged: [ids], set_aside: [{id, reason}], skipped: [ids],
  heavy_check, open: [...], children, pr_text }
```

`heavy_check` is `pass`, `none`, `fail: <why>` or `not recorded`; `open` holds
whatever the script could not settle, including a plan refused by its check
and an integration that did not complete. `pr_text` is last because it is the
longest; the full text is `<plan dir>/pr.md`.
A child that fails inside the workflow can wake this session once with a
"Workflow child failed" notice, even though the script retries it. Ignore the
notice and keep waiting for the workflow's own completion.

A child can also ask this session a question with a supervisor request while
the run goes on. Do not answer the question itself: the script decides what
happens to a stuck child. Reply that it should stop and write `blocked:` and
its question as the first line of its report, then keep waiting.

Tell the user the branch first, then what merged, each set-aside task with its
reason, the skipped tasks, the heavy-check result and each `open` line, and
point at `pr.md`. Do not push, open the pull request or merge unasked.

## Claude Code binding

Claude Code has no workflow engine, so the main session does the script's work
with the Agent tool, one `subagent_type` per role (`implementer`, `reviewer`;
their definitions are installed), in the same order and with the same
`recipe-gate` checks. Turns in the starting session are unavoidable here, and
nothing stops a helper from being retried more than once; keep to the limits
below.

1. Run `recipe-gate plan <dir> --repo <repo>` yourself. Refuse a plan that is
   not ok and report the findings. Order the tasks into waves by `depends`.
2. Per wave, dispatch one `implementer` per task, several in one message, with
   `isolation: "worktree"` and a brief as in step 3 above (task file, plan,
   repository, report path, the dependency branches to merge, commit and
   leave nothing uncommitted). Pass `model: "opus"` only for tasks whose
   header says `thinking: xhigh`. Ask each to end its report with its branch
   (`git branch --show-current`) and worktree path.
3. In that worktree run `recipe-gate task <report> --check '<check>' --owns
   '<owns>' --repo <repo>`. A blocked or failed report sets the task aside;
   a red gate goes to a fix round.
4. Dispatch a fresh `reviewer` (diff variant) per task with the task file,
   branch, worktree, diff command, check and `<dir>/review-<id>-<n>.md`; read
   the verdict with `recipe-gate verdict`. On needs-work send the findings to
   the same implementer (SendMessage to its agent id) so it fixes them in its
   own worktree; if that agent cannot be continued, dispatch a new
   `implementer` without isolation told to work in the existing worktree.
   At most two fix rounds, then set the task aside with its reason and skip
   whatever depends on it. Retry a helper that fails by itself once.
5. Dispatch one `implementer` with the integration brief (no isolation),
   then run `recipe-gate integrate <dir> --tasks id:branch,... --branch
   <branch>` to confirm the result.
6. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched, and report as in the pi binding.

What differs from pi: the main session spends turns on every step and
re-reads its own conversation after each helper returns; a fix round
continues a helper through SendMessage rather than a retained run; waves
cannot be forced to three at a time; there is no spawn cap or timeout
enforced for you; the worktrees are Claude Code's, so their branch and path
come from the implementer's report, not from the gate running inside them.
