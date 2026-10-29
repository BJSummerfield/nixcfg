# pi mechanics (main session only)

Helpers never see this part: they get the repository's `AGENTS.md` and their
own prompt.

## Task directory

One helper is `subagent {agent, task, output}`; it runs in the background
by default and a completion notice wakes this session. Always pass
`output` as an absolute path in `$TMPDIR/pi-plans/<task>/`. That directory
holds the session's own `notes.md` (the request, decisions, helpers running
with their run ids, and each retry or escalation call) and every helper's
output. Every agent returns only a pointer to its output file
(`outputMode: file-only`); read the file. Keep `notes.md` current so a
restarted session resumes from it. If a completion notice is missing after
a restart, check `subagent {action: "status", id}` with the run id from
`notes.md`. Keep the task text short: the goal, paths, and where any longer
brief is. Children start with fresh context: they see only their own prompt,
the repository's `AGENTS.md` and the task text. Leave `model` out: nix sets
each agent's model and thinking. Give every helper a `timeoutMs` in
`options`.

## Research

Dispatch the bundled `researcher` for web questions and one `scout` per
group of repository questions, in parallel; optionally an `evidence-auditor`
on a research brief whose decisions rest on few sources. Summarise for the
user from the files.

## Plan

One `planner`, given the goal, the user's decisions and the paths of every
research and scout file. Its task files may carry `research:` questions;
answer each with a researcher or a scout before that task starts. Then a
fresh `reviewer` checks the plan.

## Work a task list

Tasks start once their `depends` are merged. Cut each task's worktree and
branch from the session's own branch after its dependencies are merged into
it, so the task branch already holds them. Never pass `worktree: true`:
pi-subagents deletes that worktree and its branch when the run ends,
keeping only a patch. The session owns worktrees: for a task it runs
`git worktree add -b <branch> /var/tmp/pi-worktrees/<repo>/<task> <base>`
and dispatches the implementer with `cwd` set there; a fix round or a
handoff continuation is dispatched into the same worktree. Then check it
yourself: rerun the task's check, `git diff --stat <base>..<branch>` shows
only owned files, `git status` is clean. Then a fresh reviewer in its own
detached worktree, `git worktree add --detach
/var/tmp/pi-worktrees/<repo>/<task>-review-<n> <branch>`, never the
implementer's. Its report's first line is `verdict: clean` or
`verdict: needs-work`. On `needs-work`, a fix round: a fresh implementer in
the same task worktree with the review's blocking findings. On clean, merge
the task branch into the session's own branch and remove both worktrees
(`git worktree remove`, `git branch -d`). When all are merged, run the
plan's final checks once and write the pull request text; the pull request
is opened from the session's own branch.

## Judgement

Guidance, not rules. A `handoff:` is continued by a fresh helper of the
same role, with the original task plus the note to continue from and not
redo committed work. After 2 continuations that commit nothing new, split
the task or ask the user. At most 2 fix rounds, then ask. A `blocked:` gets
one retry with a corrected brief, then ask. An engine error or timeout gets
one retry. A choice only the user can make: stop and ask. Record each call
in `notes.md`.

## Capacity

At most 3 helpers run at once for the session. A dispatch rejected for
capacity is not a failure: wait for a completion notice, then dispatch it
again. Do not poll: after a dispatch, end the turn or do other work, and
use `bg_wait` only when nothing else can proceed. A `parallel` call needs
an `output` on the outer call; each child gets a path derived from it.

## Run status

Read the output file, not the run status: a completed run is not finished
work and a failed one is not failed work. An implementer's run may show
acceptance or review requirements from pi-subagents; the session's own gate
and reviewer decide, not the run status.

## Own context

Read helpers' files, not whole logs; tail long command output; send a scout
instead of reading many files yourself. Reasoning and the answer share one
output budget, so a long deliverable at high thinking can spend it all
thinking and return nothing; that is why reviewers write the verdict first.
Output room per turn shrinks as the transcript grows. Compaction makes no
model call: earlier turns become a resume card (task, plan files, modified
files, last message). Facts that must survive go in files. Do not read
images in this session (the environment file says why); a helper that
overruns the image limit loses only its own run. Re-dispatch with fewer
images per helper and recover its files rather than reviving it.
