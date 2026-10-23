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
  have a clean working tree, because the runner refuses to make task
  worktrees from a dirty source checkout.
- optional: `branch` (name of the integration branch, default
  `implement/<name of the plan directory>`), `limit` and `sizing` (as in the
  plan skill, for the plan check), `childTimeoutMs`, `bigTimeoutMs`.

The plan directory is also the task directory. The run writes into it, next
to the plan:

```
<dir>/run.json              the ledger: base commit and ref, and every worktree and
                            branch the run made
<dir>/abandoned.json        what `recipe-gate abandon` removed
<dir>/deps/<id>/            worktree where a task's dependencies are merged
<dir>/wt/<id>/              task worktrees (Claude Code binding)
<dir>/review/<id>-<n>/      the reviewer's own worktree for review n of a task
<dir>/resolve-<scope>-<n>.md report of resolver n for a merge (a task id or integration)
<dir>/impl-<id>.md          implementer report; a retried one is impl-<id>.retry.md,
                            a replanned attempt n is impl-<id>-<n>.md
<dir>/review-<id>-<n>.md    review n of the task
<dir>/fix-<id>-<n>.md       report of fix round n
<dir>/diagnosis-<id>-<n>.md diagnosis n of the task (or of the integration)
<dir>/integration.md        report of the integration step (integration-2.md
                            when a diagnosis ran it again)
<dir>/integration/          worktree of the integration branch
<dir>/heavy.md              first line pass, none or fail: <why>, then the output
<dir>/pr.md                 pull request title and body
<dir>/receipt.md            the receipt
```

Task worktrees are managed by the runner under
`/var/tmp/pi-worktrees/<repository name>/`, one per implementer attempt, and
that directory is emptied of anything older than 20 days. When the
integration passes its check, the tidy removes the worktree and deletes the
branch of every task it merged, the review worktrees, the dependency
worktrees and the base ref. What stays is the integration branch
`implement/<name of the plan directory>`, which holds the finished work for
you to push, and the worktrees and branches of tasks that were set aside or
replaced by a replan, which are not merged anywhere. The receipt lists the
latter as `left`; `recipe-gate abandon <plan dir> --keep <integration
branch>` removes them on request (`--keep a,b` keeps branches).

## What runs

1. One scout child exists only to carry the plan gate: `recipe-gate plan`
   checks sizes, file ownership, dependencies and that every task has a
   check. A gate runs only after a child, and this child is the cheapest one;
   the plan check, not the child, decides. A plan that is not ok is refused
   with the check's findings in the receipt, before any worktree exists.
   Then `recipe-gate pin` fixes the run's base: the repository's HEAD commit
   and a ref to it, written to `<dir>/run.json`. Every task starts from that
   base, so the checkout may move while the run goes on.
2. Tasks are ordered by `depends` into waves. A task runs once everything it
   depends on has finished; a task whose dependency was set aside or skipped
   is skipped. Within a wave the tasks run in parallel, three at a time at
   most.
3. A task with dependencies first gets a worktree at `<dir>/deps/<id>` on its
   own branch, made by `recipe-gate merge`, which merges the dependencies'
   branches into the base. No model merges: a conflict goes to a resolver
   (step 6). Then an implementer in a worktree whose branch already holds
   the dependencies reads the research notes under
   `<plan dir>/research/<id>/` when the task asks a `research` question,
   makes its change, commits it and writes its report. `recipe-gate task`
   then runs in that worktree and reports the branch, the commits since the
   task's base, the files changed outside `owns`, whether anything is
   uncommitted and the result of the task's check run once more. A report
   that says `blocked` or `failed` goes to a diagnosis (step 7).
4. A fresh reviewer (diff variant) works in its own worktree of the task's
   branch, a new one for every review round (`<dir>/review/<id>-<n>`), reads
   the branch's own diff, runs the check there and never touches the
   implementer's worktree. It gives a verdict (`recipe-gate verdict`, which
   records the review worktree). On needs-work, or when the task gate was
   red, the same implementer is resumed in the same worktree with the
   findings and fixes them in new commits; then a fresh review. At most two
   fix rounds; a task still not clean goes to a diagnosis. Other tasks go
   on.
5. The finished branches that no other finished task builds on are merged by
   `recipe-gate merge` into the integration worktree `<dir>/integration`,
   branch `implement/<name of the plan directory>`, made from the base ref;
   the checkout does not move. Then one implementer with a brief (no
   worktree of its own) runs the plan's heavy checks once from that
   worktree, under the box-wide lock, and writes `pr.md` and `heavy.md`.
   `recipe-gate integrate` then confirms every finished branch is in the
   branch, nothing is uncommitted, `pr.md` is not empty and the heavy checks
   passed or were not needed, and with that it tidies (above); a worktree or
   branch it could not remove is an `open` line. Nothing here merges into
   the main branch or pushes.
6. A merge that conflicts stops with the conflict named; a resolver (an
   implementer with a brief, no task file) is sent into that worktree, where
   the merge is already started. It edits only the conflicted files, runs
   `git add` and `git commit --no-edit`, runs the conflicting task's check
   and reports; it starts no other merge operation. The merge gate then runs
   again. A resolver that leaves the same conflict, or a third conflict
   that is still open, ends in `open` and a question for the user.
7. A child that fails by itself is retried once (a fix round is resumed again
   from the failed run). Whatever the script cannot accept goes to a diagnose
   child (a fresh reviewer, diagnosis variant) at once, for that task only:
   a child that failed twice, a `blocked` or `failed` report, a verdict
   that cannot be read, a task still not clean after two fix rounds, an
   integration the check does not accept. It reads the evidence and picks one
   action that `recipe-gate diagnosis` checks against the actions allowed at
   that step: `continue` (the output was fine, for example a verdict in the
   wrong place), `retry`, `fix` (one more round for the same implementer
   with its brief), `replan` (a fresh implementer in a new worktree with a
   revised brief, and files it may add to `owns` when no task outside its
   dependencies owns them) or `decide`. Each task gets at most two
   diagnoses, and the same diagnosis twice counts as `decide`. A `decide`
   sets the task aside and goes in the receipt as a question for the user;
   tasks that depend on it are skipped.
8. After every round the script emits a board (each task's state, next step,
   fix rounds and diagnoses, what healed, what needs a decision);
   `recipe-status <plan dir>` prints it with the children still running,
   from any shell.

A gate with side effects (the merges and the integration tidy) is run by the
script only: the child it follows is not told to run it first, because the
child's own run would change what the script's run sees. Gates without side
effects (plan, task, verdict, diagnosis) are run by the child before it
reports, and again by the script.

The pi mechanism behind the implementer and reviewer runs: a workflow child with `worktree: true`
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
    plan: "<plan dir>", repo: "<repo path>"
  },
  cwd: "<repo path>",
  async: true,
  output: "<plan dir>/receipt.md",
  options: { timeoutMs: 14400000, maxSubagentSpawnsPerRun: <16 x tasks + 6> }
})
```

All paths are absolute. `cwd` is the repository, so the worktrees branch from
it. Wait for the single completion with `bg_wait`; do not poll, steer or read
intermediate files. Then read only the receipt, `<plan dir>/receipt.md`.

The receipt file is a one-line summary whose Return part is the receipt JSON
cut at 1,000 characters; the summary names the run's `status.json`, whose
`workflow.value` holds the whole receipt.

```
{ base, branch, merged: [ids], set_aside: [{id, reason}], skipped: [ids],
  report: ["<id>: merged" | "<id>: set aside (<reason>)" | "<id>: skipped (<id> not done)" | "<id>: not merged"],
  heavy_check, healed: [{id, step, action, reason}],
  decide: [{id, step, question, diagnosis}], open: [...],
  left: [{id, kind, branch, worktree}], cleanup, children, pr_text }
```

`base` is the commit every task started from. `left` holds the worktrees and
branches still in the repository, and `cleanup` is the command that removes
them (`recipe-gate abandon <plan dir>`, keeping the integration branch once
it passed), empty when `left` is. The integration branch is never in `left`
after a pass.
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

Tell the user the branch first, then the `report` lines (one per task, in plan order), then what merged, each `decide` question with
its diagnosis file, each other set-aside task with its reason, the skipped
tasks, the heavy-check result, what healed in one line each, and each `open`
line, and point at `pr.md`. Report `left` and the `cleanup` command; do not
run it, because the user may want those worktrees. Do not push, open the pull request or merge
unasked, and do not answer a `decide` question for the user.

## Claude Code binding

Claude Code runs no pi-subagents workflow script: its Workflow tool has a different
child API and must be opted into per run, and a headless `claude -p` runner for
the same script has not been built. So the main session does the script's work
with the Agent tool, one `subagent_type` per role (`implementer`, `reviewer`;
their definitions are installed), in the same order and with the same
`recipe-gate` checks. Turns in the starting session are unavoidable here, and
nothing stops a helper from being retried more than once; keep to the limits
below.

1. Run `recipe-gate plan <dir> --repo <repo>` yourself. Refuse a plan that is
   not ok and report the findings. Run `recipe-gate pin <dir> --repo <repo>`
   and keep the `base` it prints: it is the `--base` of a task without
   dependencies. Order the tasks into waves by `depends`.
2. Per task, make its worktree yourself: `recipe-gate merge <dir>/wt/<id>
   --dir <dir> --branch <branch>-task-<id> --tips <deps> --kind task --id
   <id>`, where `<deps>` is `id:branch,...` of its dependencies (omit
   `--tips` for a task without any). For a task with dependencies keep the
   `head` this merge prints: it is that task's base. A conflict goes to one `implementer`
   with the resolver brief (the worktree, the conflicted files, the check),
   then run the merge again. Dispatch one `implementer` per task, several in
   one message, without isolation, told to work in that worktree, with a
   brief as in step 3 above (task file, plan, repository, report path,
   commit and leave nothing uncommitted). The branch already holds the
   dependencies; the implementer never merges. Ask each to end its report
   with its branch and worktree path.
3. In that worktree run `recipe-gate task <report> --check '<check>' --owns
   '<owns>' --repo <repo> --base <base> --run <dir> --id <id>`, where
   `<base>` is the pinned base for a task without dependencies and the `head`
   of its step-2 merge otherwise. A blocked or
   failed report goes to a diagnosis (step 5 of this list); a red gate goes
   to a fix round.
4. For each review make the reviewer's worktree the same way, at a fresh path
   per round: `recipe-gate merge <dir>/review/<id>-<n> --dir <dir> --branch
   <branch>-review-<id>-<n> --onto refs/heads/<task branch> --kind review
   --id <id>`, with no tips. Dispatch a fresh `reviewer` (diff variant)
   there with the task file, branch, that worktree, diff command (from the
   same `<base>` as step 3), check and `<dir>/review-<id>-<n>.md`; run
   `recipe-gate verdict <file> --run <dir> --id <id>` inside that review
   worktree, never in your own checkout. On needs-work send the findings to the same implementer
   (SendMessage to its agent id) so it fixes them in its worktree; if that
   agent cannot be continued, dispatch a new `implementer` without isolation
   told to work in the existing worktree. At most two fix rounds, then a
   diagnosis. Retry a helper that fails by itself once.
5. Where the pi script diagnoses (step 7 of What runs), dispatch a fresh
   `reviewer` (diagnosis variant) with the task file, the step, what went
   wrong, the evidence files, the allowed actions and
   `<dir>/diagnosis-<id>-<n>.md`, read it with `recipe-gate diagnosis <file>
   --allow <actions>`, and act on it with the same limits. Do not decide in
   its place: a `decide` goes to the user.
6. Run the integration merge yourself: `recipe-gate merge <dir>/integration
   --dir <dir> --branch <branch> --tips id:branch,... --kind integration
   --id integration`, with the finished branches no other finished task
   builds on, in the plan's order. A conflict goes to one `implementer`
   with the resolver brief, and the merge runs again. Then dispatch one
   `implementer` with the integration brief (heavy checks and `pr.md` in
   that worktree, no merging), and run `recipe-gate integrate <dir> --tasks
   id:branch,... --branch <branch> --tidy yes` to confirm and tidy.
7. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched, and report as in the pi binding, with `left` and the
   `cleanup` command.

What differs from pi: the main session spends turns on every step and
re-reads its own conversation after each helper returns; a fix round
continues a helper through SendMessage rather than a retained run; waves
cannot be forced to three at a time; there is no spawn cap or timeout
enforced for you; the worktrees are the ones you made, so the ledger in
`<dir>/run.json` is filled by the merge gates and by `task` and `verdict`
with `--run`.
