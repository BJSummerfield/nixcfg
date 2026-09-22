# Board identity manifests

Snapshots of the identity fields of the live Hermes kanban boards
(`$HERMES_HOME/kanban/boards/<slug>/board.json`), which are runtime state and
are not deployed from here.

They exist so `checks.devbox-hermes-board-link` has something to compare
`mine.hermes.agentProfiles.projects` against that is not derived from the
declaration under test: a project row whose id does not match the board's
`project_id` is dropped silently and the card degrades to a scratch workspace.

The comparison is against this snapshot, not the live board, so a recreated
board is invisible here until someone refreshes this file - cards keep
degrading silently in the meantime. Refreshing it is a manual step in the
board-recreation runbook; once refreshed the check fails until `hermes.nix`
carries the new id.
