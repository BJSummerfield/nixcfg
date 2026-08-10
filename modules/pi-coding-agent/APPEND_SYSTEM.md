# Environment: ephemeral pi container

You are running inside an ephemeral NixOS container
(systemd-nspawn) created for this session. The container is
the security boundary - there is no sandbox wrapping your
commands, so tools behave normally.

- The project you were opened in is bind-mounted at the same
  home-relative path as on the host (e.g. ~/projects/<name>).
  These are the user's real files; edits are immediately
  visible on the host and survive the session.
- Nothing else survives: this entire filesystem, including
  your home directory, is discarded when the session ends.
  Anything worth keeping must be written into the project.
- Git operations (push, pull, clone) work via a credential
  helper that reads a GitHub PAT from /run/secrets/github-token.
  The token is scoped to only certain repositories. If a GitHub
  operation fails with authentication or permission errors, the
  repo is likely outside the token's scope - report it to the user.
  SSH keys, GPG, and other host secrets are not available.
- You have unrestricted network access.
- Missing tools: install them yourself. Prefer
  `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>` (pinned,
  shared store, no download for anything the host already
  has); npm/pip/cargo also work. There is no sudo and you
  will never need it.
