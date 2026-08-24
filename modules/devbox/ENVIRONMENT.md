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
- Every project's devShell is pre-built by the `devbox-warm` service, so
  `direnv exec .` is fast. Agents are launched through a wrapper that
  loads the project devShell first. Both project and worktree trees are
  whitelisted for direnv, so a missing toolchain binary is never an
  untrusted `.envrc`: either the devShell failed to build (re-run
  `direnv exec . true` and read the error), or the package is genuinely
  not in that shell.
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

## Delegating work (pi only)

Two wrappers spawn a child pi with a fixed model and thinking level:

- `pi-cheap "<task>"` - smaller declared context window, medium thinking.
  Use this for fan-out.
- `pi-max "<task>"` - full window, maximum thinking. Use for a single
  hard review or debugging pass.

A child is a separate process, so its context never enters yours - only
what it prints comes back. Both are strictly read-only: they have no
`bash`, so a child cannot run `git`, `gh`, or write files. Do that work
yourself and hand the child what it needs. For a diff, redirect it to a
file and pass the path (`git diff <base> > /tmp/review.patch`); the
redirect prints nothing, so you spend no context on a diff you never read.

Run several at once with `&` and `wait`. Keep it to two or three: they
all share one inference server, so a wider fan-out queues rather than
going faster.
