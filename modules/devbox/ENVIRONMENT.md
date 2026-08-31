# Environment: persistent devbox container

You are running inside a long-lived NixOS container (systemd-nspawn).
The container is the security boundary - there is no sandbox wrapping
your commands, so tools behave normally.

- This container persists across sessions and across host reboots. Your
  home directory, your shell history and anything you install by hand
  are still here next time. Do not treat this as scratch space that
  cleans itself up.
- Projects live in `/home/agent/projects` and paseo worktrees in
  `/var/lib/paseo/worktrees`. Neither is bind-mounted from the host:
  they exist only inside this container, so uncommitted work is not
  backed up by anything. Push anything you care about.
- Agents are launched through a wrapper that loads the project devShell
  (`direnv exec .`) before the agent starts. The first launch after a
  flake change pays a one-time devShell eval - a few seconds if the
  dependencies are already in the store, longer only if new dependencies
  must be downloaded or built - and later launches are fast. Both project
  and worktree trees are whitelisted for direnv, so a missing toolchain
  binary is never an untrusted `.envrc`: either the devShell failed to
  build (re-run `direnv exec . true` and read the error), or the package
  is genuinely not in that shell.
- Missing tools: prefer `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>`
  - the store is shared with the host, so anything it already has costs
  no download. npm/pip/cargo also work. There is no sudo and you will
  never need it.
- Git push, pull and clone authenticate through a credential helper that
  reads a GitHub PAT at use time. `gh` is separate: a wrapper exports
  `GH_TOKEN` from the same secret. The token is scoped to specific
  repositories, so an auth or permission failure usually means the repo
  is out of scope - report it rather than retrying.
- You have unrestricted network access.

## Subagents

Subagent fan-out comes from the pi-subagents plugin - its entry points,
roles and tier mapping are the plugin's own documentation to read, not
environment facts. Three that are:

- All children hit the same single local inference server, so keep
  parallel fan-out to two or three tasks - a wider wave queues rather
  than going faster. A child that looks slow while another build is
  running is waiting for a lane, not stuck.
- `researcher` is the role with web access; the others do not have it.
- Nothing here has a browser. Web search and fetch return text, never a
  rendered page or a screenshot.

## Updating agent plugins

pi runs `pi-subagents` and `pi-web-access`; Claude runs its own
Superpowers plugin, which is unrelated to either. Nix declares membership
only - which plugins, no versions, no hashes - in
modules/devbox/plugins.nix, so nothing version-shaped goes stale between
rebuilds. Versions float, and a running container is updated with:

- pi: `pi update --extensions` - latest npm packages.
- Claude: `claude plugin update` - follows the official marketplace's
  current pin.

Updates persist across rebuilds: a rebuild re-seeds the membership specs
and the role tiering, never the versions. A fresh container gets the pi
plugins on pi's first start; for Claude run the one-time bootstrap:
`claude plugin marketplace add anthropics/claude-plugins-official` then
`claude plugin install superpowers@claude-plugins-official` - the
seeded enabledPlugins entry turns it on.

A bad release? Pin it down for the interim: add a version to the pi spec
in modules/devbox/plugins.nix and rebuild. The claude plugin id carries
no version slot (its version is pinned by the official marketplace) - the
claude-side lever is temporarily removing the enabledPlugins entry in
modules/devbox/container.nix.
