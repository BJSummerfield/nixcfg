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
