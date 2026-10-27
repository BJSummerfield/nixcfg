# pi mechanics (main session only)

Helpers never see this part: they get the repository's `AGENTS.md`, the
environment file and their own prompt.

## Dispatching

- One helper is `recipe_dispatch {role, brief, output}`. The foreground call
  waits and returns the Result; `background: true` returns at once and wakes
  this session once with the Result, so do not poll. Several at once are
  several background calls. A whole recipe (`research`, `plan`, `implement`,
  `investigate`) is `recipe_run {recipe, args}`; it wakes once with the
  receipt.
- Always pass `output` as an absolute path; the Result carries the saved
  path, never the body.
- Keep the brief short: paths and where the details are. Long text goes to
  a file first; a few KB inline arrives truncated.
- Leave the model out: each role's model, window, tools and thinking come
  from nix.
- Implementers run with `worktree: true`, one worktree per task. `gate` is a
  shell command run after the child; its exit is part of the Result.
- Give every helper a `timeoutMs`.
- The roles are `planner`, `scout`, `locator`, `searcher`, `extractor`,
  `synthesizer`, `implementer` and `reviewer`.

## Waiting and recovery

- A background run pushes nothing but its one wake. Silence proves nothing:
  leave it and end the turn or do other work.
- A failed or timed-out Result is not failed work and a clean one is not
  finished work: read the output file. A report whose first line starts with
  `FAILED:` was cut off by the output valve and counts as failed.
- A Result with `handoff` set is a child that reached its context budget and
  handed off, not a failure: its output file holds what is done and what is
  left (with `empty`, only its branch does).
- `recipe_run` with `resume: true` continues a recipe from its task
  directory.
- After a pi or paseo restart the wake is lost. A recipe run carries on
  without the session: check it with `recipe-status <task dir>` or wait for it
  with `recipe-run wait <task dir>`, and do not start it again; the runner
  refuses a second start while the first is alive. A dispatched helper with
  an output file is done; one without is dispatched once more, then recorded
  as failed.

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
