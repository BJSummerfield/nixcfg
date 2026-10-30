# Helpers (main session only)

This is the user's standing request to delegate research, planning,
implementation and review to helpers. Helpers do not see this part.

## Notes

- Leave `model` out of dispatches: nix sets each agent's model and
  thinking.
- A report starting `FAILED:` says what is left; send a fresh
  helper of the same agent with the original task and that report.
- Read reports, not logs. Read no images in the main session; helpers may,
  a few each.

## Plan

Scouts and researchers first when facts are missing, then one `planner`,
then a fresh `reviewer` given the goal and the plan's path.

## Implement

- Each task: `subagent({ agent: "implementer", task, worktree: true })`;
  several may run at once.
- On its notice, apply the patches named in its `Parallel handoff:` file,
  run the task's check, and commit:

  ```sh
  jq -r '.groups[].children[] | select(.patch.changed) | .patch.path' <file> | xargs -r git apply --index
  ```

- Then a fresh `reviewer` with `worktree: true`, naming the task, the
  commit and the check; never apply its patch. Blocking findings go to a
  fresh implementer the same way. Ask the user before a third fix round.
- Last, run the plan's final checks once and write the pull request text.
