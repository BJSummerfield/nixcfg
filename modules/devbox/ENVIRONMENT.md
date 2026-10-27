# Environment: persistent devbox container

You are inside a long-lived NixOS container (systemd-nspawn). The container is
the security boundary; no sandbox wraps your commands.

- Three identical containers exist: `devbox`, `workbox` and `research-box`;
  `hostname` says which one you are in. Anything installed by hand is per
  container.
- The container persists across sessions and host reboots: home, shell
  history and hand-installed tools are still here next time. Projects live in
  `/home/agent/projects`, paseo worktrees in `/var/lib/paseo/worktrees`;
  neither is backed up anywhere. Push anything you care about.
- The agents' configuration is generated from the nixcfg repository: pi's
  under `~/.pi/agent`, claude's under `~/.claude-state` (`CLAUDE_CONFIG_DIR`;
  there is no `~/.claude`). Editing those files in place does not persist and
  can break the next activation; a change to them is a pull request to
  nixcfg. The one writable exception is claude's per-project `memory/`
  directory under `CLAUDE_CONFIG_DIR`.
- A fact worth keeping about a repository goes in that repository's
  `AGENTS.md`, in the same change that taught it; a fact about this
  environment is a request to the user,
  made in the report or the pull request, never by asking.
- `/tmp` is a RAM tmpfs, wiped on reboot, capacity is memory. Never put
  anything large there (a build tree, a `CARGO_TARGET_DIR`): ENOSPC kills
  builds and running processes alike.
- `/var/tmp` is on disk and is `$TMPDIR`. It survives reboots but nothing in
  it is durable: systemd-tmpfiles removes entries 20 days after their last
  write (the filesystem is `noatime`, so reading does not refresh age); the
  recipe runner removes its worktrees under `/var/tmp/pi-worktrees` after 20
  days.
- Memory is shared with the local LLM engine's pinned host cache. Expensive
  commands (full test suites, flake checks, release builds) run one at a time
  box-wide: `flock -w 7200 /var/tmp/pi-plans/locks/heavy.lock <command>`.
  A command written down for something else to run later, such as a plan's
  final checks, carries the same wrapper.
- The local LLM engine admits @imageBudget@ images per prompt, counted over
  the whole conversation because history is resent every turn. Exceeding it
  is terminal for that session: every later request fails with
  `At most @imageBudget@ image(s) may be provided in one prompt`. Each read
  of an image spends one of them; take notes on first sight and never look
  twice.
- The engine lists its recent requests, with the prompt size of each, at
  `/ops/requests?n=<N>` on the same host and port as the model endpoint.
- The local engine runs 4 sequences at once; helpers run at most 3 at a
  time. A prefill on one sequence stalls decode on the others.
- Missing tools: `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>` (the store
  is shared with the host, so anything it has costs no download); npm, pip
  and cargo also work. There is no sudo and you will never need it.
- Refer to tools by package name, never by a `/nix/store/<hash>-...` path:
  garbage collection deletes unreferenced paths, so a recorded hash works
  until it abruptly does not.
- Git push, pull and clone authenticate through a credential helper reading a
  GitHub token; `gh` gets `GH_TOKEN` from the same secret. The token is scoped
  to specific repositories, so an auth or permission failure usually means the
  repository is out of scope: report it rather than retrying.
- Network access is unrestricted.
