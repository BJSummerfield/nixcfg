# pi mechanics (main session only)

Helpers never see this part: they get the repository's `AGENTS.md` and their
own prompt.

## Dispatching

- One helper is `subagent {agent, task, output}`; it runs in the background by
  default and a completion notice wakes this session. Several at once use the
  built-in `parallel` workflow; dependent steps a workflow script. In a script
  every launch is awaited; do not root a launch chain in `Promise.resolve()`
  after the first await.
- Always pass `output` as an absolute path in the task directory,
  `$TMPDIR/pi-plans/<task>/`. That directory also holds the session's own
  notes and state, so a resumed or restarted session can pick them up from
  files. Every agent returns only a pointer to its output file
  (`outputMode: file-only`); read the file.
- Keep the task text short: the goal, paths, and where any longer brief is.
  Children start with fresh context: they see only their own prompt, the
  repository's `AGENTS.md` and the task text.
- Leave `model` out: nix sets each agent's model and thinking.
- Give every helper a `timeoutMs` in `options`.
- Never pass `worktree: true`: pi-subagents deletes that worktree and its
  branch when the run ends, keeping only a patch. The session owns worktrees
  instead. For a task it runs
  `git worktree add -b <branch> /var/tmp/pi-worktrees/<repo>/<task> <base>`
  and dispatches the implementer with `cwd` set to it; a fix round or a
  handoff continuation is dispatched into the same worktree. A reviewer gets
  its own `git worktree add --detach /var/tmp/pi-worktrees/<repo>/<task>-review-<n> <branch>`,
  never the implementer's. The session merges finished branches and removes
  worktrees it no longer needs (`git worktree remove`, `git branch -d`).
- The agents, and when to use each: `planner` turns an acceptance criterion
  into a task plan; `scout` locates code and answers where-is questions before
  a plan; `implementer` runs one task file in a worktree; `reviewer` reviews
  a finished task's diff; `researcher` (bundled) does web research and cites
  its sources; `evidence-auditor` (bundled) checks a research brief's claims
  against those sources.

## Waiting and recovery

- After a dispatch, end the turn or do other work; do not poll. Use `bg_wait`
  only when nothing else can proceed. Notices arrive wrapped in a
  `<pi_subagents_notice>` tag.
- Read the output file, not the run status: a completed run is not finished
  work and a failed one is not failed work.
- A reply or note whose first line starts with `handoff:` means the helper
  reached its context budget and wrote what is done and what is left.
  Dispatch a fresh helper of the same role with the original task plus a line
  to continue from that note and not redo committed work.
- A first line starting `FAILED:` means the helper was stopped by the output
  limit or by compaction thrash; treat it as failed work.
- After a pi restart, completion notices are delivered when the session
  reopens; if one is missing, check `subagent {action: "status", id}`.

## Context

- Reasoning and the answer share one output budget, so a long deliverable at
  high thinking can spend it all thinking and return nothing; that is why
  reviewers write the verdict first.
- Output room per turn shrinks as the transcript grows. Compaction makes no
  model call: earlier turns become a resume card (task, plan files, modified
  files, last message). Facts that must survive go in files.
- Do not read images in this session (the environment file says why); a
  helper that overruns the image limit loses only its own run. Re-dispatch
  with fewer images per helper and recover its files rather than reviving
  it.
