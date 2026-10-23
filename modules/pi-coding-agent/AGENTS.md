# pi mechanics (main session only)

Helpers never see this part: they get the repository's `AGENTS.md`, the
environment file and their own prompt.

## Dispatching

- One helper is `subagent {agent, task, output, async: true}`; several at
  once is `workflow: "parallel"`; dependent steps are one workflow script
  (a ```` ```js workflow ```` block in the same reply plus `subagent
  {workflow: true}`, or a script file path). Run `subagent {action:
  "validate", workflow: true}` before any long launch.
- Always pass `output` as an absolute path. A path that is only mentioned in
  the task text is not binding; the report would land under the session's
  `subagent-artifacts/` instead. The completion notice carries the saved
  path, never the body.
- Keep the task text short: paths and where the brief is. Long text goes to
  a file first; a few KB inline arrives truncated.
- Leave `model` out: each role's model, window, tools and thinking come from
  nix.
- Implementers run with `worktree: true`, one managed worktree per task.
- Give every helper a `timeoutMs` in `options`; a workflow has no deadline
  of its own.
- The roles are `planner`, `scout`, `searcher`, `extractor`, `synthesizer`,
  `implementer` and `reviewer`.

## Waiting and recovery

- Nothing pushes a running helper's state into this session. After an async
  dispatch, `bg_wait` or poll `subagent {action: "status", id}`; silence
  proves nothing. If `status` says running, leave it. Steer only a helper
  with turns and tools on record that has visibly stalled, and every steer
  must say to continue the task afterwards: a steer is a turn, and "report
  status" ends the run.
- A `failed` run is not failed work and a `completed` run is not finished
  work: read the output file. A report whose first line starts with
  `FAILED:` was cut off by the output valve and counts as failed.
- A `resume` without its own `output` saves beside the original as
  `<name>.<run id>.md`; read the path in its notice.
- After a pi or paseo restart, completion notices are lost but `status` by
  run id still works. Check each run you started by id: one with a result
  file is done; one that is neither running nor has a result is dispatched
  once more, then recorded as failed.
- A helper's `contact_supervisor` arrives as a needs-attention; answer with
  `subagent_supervisor` (`list`, `pending`, `status`, `reply`).
  `contact_supervisor` in your own tool list only errors.

## Context

- Reasoning and the answer share one output budget, so a long deliverable at
  high thinking can spend it all thinking and return nothing; that is why
  reviewers write the verdict first.
- Output room per turn shrinks as the transcript grows. Compaction makes no
  model call: earlier turns become a resume card (task, plan files, modified
  files, last message). Facts that must survive go in files.
- A forked helper re-prefills the whole parent context and starts inside its
  compaction window; fork only one that needs this session's working
  context.
- Do not read images in this session (the environment file says why); a
  helper that overruns the image limit loses only its own run. Re-dispatch
  with fewer images per helper and recover its files rather than reviving
  it.
