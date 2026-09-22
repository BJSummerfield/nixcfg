# Board identity manifests

Snapshots of the identity fields of the live Hermes kanban boards
(`$HERMES_HOME/kanban/boards/<slug>/board.json`), which are runtime state and
are not deployed from here.

They exist so `checks.devbox-hermes-board-link` has something to compare
`mine.hermes.agentProfiles.projects` against that is not derived from the
declaration under test: a project row whose id does not match the board's
`project_id` is dropped silently and the card degrades to a scratch workspace.

If a board is recreated its `project_id` changes, the check fails, and both
this file and the declaration in `hermes.nix` need the new id.
