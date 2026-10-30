# Helpers (main session only)

This is the user's standing request to delegate research, planning,
implementation and review to helpers. Helpers do not see this part.

## Agents

`scout`: where things are in a repository. `researcher` (bundled): web
research with sources. `evidence-auditor` (bundled): checks a research
report's key claims. `planner`: a plan from a goal and gathered facts.
`implementer`: one task of a plan. `reviewer`: reviews a change or a plan
and runs the check.

## Dispatch

- One helper: `subagent({ agent, task })`. Independent helpers that change
  no files: `subagent({ workflow: "parallel", args: { tasks: [{ agent,
  task }, ...] } })`.
- Keep the task short: the goal, the paths, the user's decisions and the
  reports to read. Leave `model` out: nix sets each agent's model and
  thinking.
- At most 3 helpers at once, counting each `parallel` child: the engine
  runs 4 sequences and this session needs one. A dispatch refused for
  capacity is sent again after the next completion notice.
- Do not poll or call `bg_wait`; the completion notice wakes this session.
  It shows the start of the reply and the path of the full report.
- Answer a helper's `contact_supervisor` question with
  `subagent_supervisor({ action: "reply", replyTo, message })`. Ask the
  user only what only the user can decide.
- A report starting `handoff:` or `FAILED:` says what is left; send a fresh
  helper of the same agent with the original task and that report.

## Plan

Scouts and researchers first when facts are missing, then one `planner`,
then a fresh `reviewer` given the goal and the plan's path.

## Implement

- Commit first: `worktree: true` needs a clean checkout, untracked files
  included.
- Each task: `subagent({ agent: "implementer", task, worktree: true })`.
  pi runs it in a worktree of your current commit and removes it after.
- Its notice has a `Parallel handoff: <file>` line. Apply its patch on your
  branch, run the task's check, and commit:

  ```sh
  jq -r '.groups[].children[] | select(.patch.changed) | .patch.path' <file>
  git apply --index <patch>   # add --3way if it does not apply cleanly
  ```

- Then a fresh `reviewer` with `worktree: true`, naming the task, the
  commit and the check; never apply a reviewer's patch. Blocking findings
  go to a fresh implementer the same way. Ask the user before a third fix
  round.
- Last, run the plan's final checks once and write the pull request text.

## Own context

Read reports, not logs; tail long output; send a scout rather than reading
many files. Read no images here (the environment notes say why); helpers
may, a few each.
