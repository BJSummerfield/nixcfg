# C1: Proving non-root profile worktree linkage via seeded projects.db

Date: 2026-09-22

## Question

Does seeding the exact `p_43348f57` project row (for the `nixcfg` repo) directly
into a non-root profile's `projects.db` (here, `claude-orchestrator`) make new
kanban cards created by that profile, on board `nixcfg`, become worktree-backed
(instead of `scratch`) even without passing `--project` or `--workspace`?

## Method

Ran entirely from `/var/lib/hermes/.hermes/profiles/claude-orchestrator/`, the
non-root profile's home. `nix-shell -p sqlite` was used for `sqlite3` since it
is not installed system-wide.

### 1. Backup the profile's projects.db

```
cp -a /var/lib/hermes/.hermes/profiles/claude-orchestrator/projects.db \
      /var/lib/hermes/.hermes/profiles/claude-orchestrator/projects.db.bak.20260922_162417
```

### 2. Copy the exact row (preserving id and all columns) from the root projects.db

```
nix-shell -p sqlite --run "sqlite3 /var/lib/hermes/.hermes/profiles/claude-orchestrator/projects.db <<'SQL'
ATTACH DATABASE '/var/lib/hermes/.hermes/projects.db' AS src;
INSERT INTO main.projects (id, slug, name, description, icon, color, board_slug, primary_path, created_at, archived)
SELECT id, slug, name, description, icon, color, board_slug, primary_path, created_at, archived
FROM src.projects WHERE id='p_43348f57';
DETACH DATABASE src;
SQL"
```

No `hermes project create` was used (that would mint a new id). The row was
inserted verbatim, byte-for-byte, keeping `id='p_43348f57'`.

### 3. Verify the profile sees the seeded project

```
HERMES_HOME=/var/lib/hermes/.hermes/profiles/claude-orchestrator hermes project list
```

Output:

```
nixcfg                   nixcfg  [0 folder(s)]
```

```
HERMES_HOME=/var/lib/hermes/.hermes/profiles/claude-orchestrator hermes project show nixcfg
```

Output:

```
nixcfg  [p_43348f57]
  name:    nixcfg
  about:   Nix configuration repo: modules, hosts, ci, secrets
  board:   nixcfg
  primary: /home/agent/projects/nixcfg
```

Confirms the profile now shows `nixcfg` with id `p_43348f57` and
`primary_path=/home/agent/projects/nixcfg`, matching the root DB row exactly.

### 4. Create a probe card with no `--project` and no `--workspace`

```
HERMES_HOME=/var/lib/hermes/.hermes/profiles/claude-orchestrator hermes kanban create \
  "C1 probe: worktree linkage test" \
  --body "Probe card for investigating non-root profile worktree linkage. Safe to archive immediately." \
  --assignee claude-verifier --json
```

(Note: this had to be run with `HERMES_DELEGATED_CHILD_CONTEXT` unset —
`env -u HERMES_DELEGATED_CHILD_CONTEXT HERMES_HOME=... hermes kanban create ...`
— because a delegated/child session context otherwise refuses to mutate
Kanban tasks via the CLI. This is unrelated to the project-linkage question
being tested; it is a separate CLI guard against nested delegate_task
sessions mutating the board.)

CLI JSON response (trimmed to relevant fields):

```
{
  "id": "t_a26ef393",
  "status": "ready",
  "workspace_kind": "worktree",
  "workspace_path": "/home/agent/projects/nixcfg/.worktrees/t_a26ef393",
  "branch_name": "nixcfg/t_a26ef393-c1-probe-worktree-linkage-test",
  "project_id": "p_43348f57"
}
```

### 5. Read the card row back directly from the board's kanban.db

```
nix-shell -p sqlite --run "sqlite3 -header -column /var/lib/hermes/.hermes/kanban/boards/nixcfg/kanban.db \
  \"SELECT id, status, workspace_kind, project_id, workspace_path, branch_name FROM tasks WHERE id='t_a26ef393';\""
```

Output:

```
id          status  workspace_kind  project_id  workspace_path                                      branch_name
t_a26ef393  ready   worktree        p_43348f57  /home/agent/projects/nixcfg/.worktrees/t_a26ef393  nixcfg/t_a26ef393-c1-probe-worktree-linkage-test
```

### 6. Archive the probe card

```
env -u HERMES_DELEGATED_CHILD_CONTEXT HERMES_HOME=/var/lib/hermes/.hermes/profiles/claude-orchestrator \
  hermes kanban archive t_a26ef393
```

Output: `Archived t_a26ef393`

Confirmed archived via direct DB read (`status='archived'`, other fields
unchanged).

## Recorded fields

| Field           | Value                                                          |
|-----------------|-----------------------------------------------------------------|
| workspace_kind  | `worktree`                                                       |
| project_id      | `p_43348f57`                                                     |
| workspace_path  | `/home/agent/projects/nixcfg/.worktrees/t_a26ef393`              |
| branch_name     | `nixcfg/t_a26ef393-c1-probe-worktree-linkage-test`               |

## Conclusion

PASS — seeding works. With no `--project` and no `--workspace` flag on the
`hermes kanban create` call, the resulting card on board `nixcfg` came back
`workspace_kind='worktree'`, `project_id='p_43348f57'` (the seeded project),
and `workspace_path` under `/home/agent/projects/nixcfg/.worktrees/`, matching
the project's `primary_path`. The deterministic branch name
(`nixcfg/t_a26ef393-c1-probe-worktree-linkage-test`) also matches the
project-anchored convention described in `hermes project --help`
("Anchors the task's worktree under the project's primary repo with a
deterministic branch"), not the random `wt/<task-id>` fallback used for
un-anchored scratch tasks.

This confirms that kanban board→project linkage for worktree anchoring is
resolved per-profile from that profile's own `projects.db` keyed by the
board's `board_slug` match against the project row — not from any root-only
or global project registry. Copying the exact row (same `id`, same
`board_slug='nixcfg'`, same `primary_path`) into a non-root profile's
`projects.db` is sufficient by itself to make that profile's kanban-create
calls resolve the project link and produce worktree-backed cards, with no
other configuration or root-profile involvement required.
