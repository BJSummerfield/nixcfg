# Environment: persistent devbox container

You are inside a long-lived NixOS container (systemd-nspawn). The container is
the security boundary; no sandbox wraps your commands.

- Three containers exist: `devbox`, `workbox` and `research-box`; `hostname`
  says which one you are in. Anything installed by hand is per container.
- `workbox` also has `ATLASSIAN_API_TOKEN` in its agents' environment.
- `research-box` has no claude, no GitHub token and no `gh`; public
  repositories still clone over HTTPS. It runs only when started by hand.
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
  environment is a request to the user in the final report, never in a
  pull request body and never by asking.
- `/tmp` is a RAM tmpfs, wiped on reboot, capacity is memory. Never put
  anything large there (a build tree, a `CARGO_TARGET_DIR`): ENOSPC kills
  builds and running processes alike.
- `/var/tmp` is on disk and is `$TMPDIR`. It survives reboots but nothing in
  it is durable: systemd-tmpfiles removes entries 20 days after their last
  write (the filesystem is `noatime`, so reading does not refresh age).
- Memory is shared with the local LLM engine's pinned host cache. Expensive
  commands (full test suites, flake checks, release builds) run one at a time
  box-wide: `flock -w 7200 /var/tmp/pi-plans/locks/heavy.lock <command>`.
  A command run later by someone else needs the same wrapper.
- The local LLM engine admits at most 32,768 vision tokens per prompt,
  counted over the whole conversation because history is resent every turn:
  about 8 full-size 2000x2000 images. A session on that engine that goes
  over fails every later request, so it reads each image once and takes
  notes on first sight.
- The engine lists its recent requests, with the prompt size of each, at
  `/ops/requests?n=<N>` on the same host and port as the model endpoint.
- The local engine runs @localLanes@ sequences at once. A prefill on one
  sequence stalls decode on the others.
- Missing tools: `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>` (the store
  is shared with the host, so anything it has costs no download). There is
  no system pip or cargo; get them the same way. There is no sudo and you
  will never need it.
- Refer to tools by package name, never by a `/nix/store/<hash>-...` path:
  garbage collection deletes unreferenced paths, so a recorded hash works
  until it abruptly does not.
- Git push, pull and clone authenticate through a credential helper reading a
  GitHub token; `gh` gets `GH_TOKEN` from the same secret. The token is scoped
  to specific repositories, so an auth or permission failure usually means the
  repository is out of scope: report it rather than retrying.
- Network access is unrestricted.
