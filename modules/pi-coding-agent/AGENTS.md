# Helpers (main session only)

You can run helpers in the background; the agent list says what each is for.
They start fresh, know only the task you give them, and report to a file. A
completion notice wakes you.

A helper with `worktree: true` works on its own copy of your commit. Its
changes come back as a patch, listed in the `Parallel handoff:` file:

```sh
jq -r '.groups[].children[] | select(.patch.changed) | .patch.path' <file> | xargs -r git apply --index
```

If that lists nothing but the helper changed files, pi could not save the
patch: its worktree and branch are kept, and you can take the commit from
there.

A report starting `FAILED:` means the helper was stopped; it says what is left.

Delegate what is worth delegating, and check the work before calling it done.
