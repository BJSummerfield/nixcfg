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

Delegation on the pi side comes from `pi-subagents`. It ships `scout`,
`researcher`, `worker`, `reviewer`, `oracle` and `delegate` as builtins,
and nix adds one custom agent, `wp`, the sub-orchestrator. Per-role model
and thinking level are declared in
`modules/pi-coding-agent/settings.nix` under `settings.subagents`; the
plugin's own docs cover its entry points and tool surface.

The shape the roles are tiered for:

```
root dispatcher   depth 0   interviews, writes the ledger, then only
                            dispatches - never reads a diff
  wp              depth 1   fresh context per unit; researches, delegates,
                            judges, writes the ledger, commits, dies
    worker        depth 2   writes code
    reviewer      depth 2   mechanical review; the verdict is wp's
    researcher    depth 2   web and repo evidence
```

`wp` exists to be thrown away. Everything one unit of work accumulates -
research, the diff, the verdict - dies with it, so the root never grows
past its dispatch log. A `wp` that compacts is evidence the unit was too
big; split it rather than raising a window.

Depth 2 is the ceiling (`maxSubagentDepth`, seeded into the extension's
config). A child at depth 2 cannot spawn, so the tree cannot run away.

Two environment facts that matter regardless of which agent you are:

- All children hit the same single local inference server, so keep
  parallel fan-out to two or three tasks - a wider wave queues rather
  than going faster. A second busy project on this box shares the same
  three lanes.
- A subagent that looks slow while something else is mid-build is
  waiting for a lane, not stuck.
- Web search reaches subagents through `researcher`, which declares
  `web_search` / `fetch_content` / `get_search_content` and is the role to
  delegate research to - the point being that those tokens are spent off
  the orchestrator's context. `worker` and `reviewer` deliberately have no
  web tools. Search fans out across every keyless provider at once and
  merges, so a provider being throttled thins the results rather than
  failing the search; the answer names any provider that errored.
- None of this is a browser. `fetch_content` is an HTTP fetch plus text
  extraction - no JavaScript, no rendering, no screenshots - so a task
  that needs to see a page rendered is not something search or fetch can
  do today.

The root dispatcher prompt that goes with this, for a ledger-driven
project:

```text
Interview me to realise the project. Then write the ledger: GOAL.md
(charter), PLAN.md (units of work + status), LEDGER.md (append-only log),
CONTEXT.md (live state), tasks/NNN-slug.md (one per unit: brief,
findings, verdict). The test is: I can kill you at any unit boundary and
a fresh agent resumes from these files alone.

After the interview YOU DO NO WORK. Your only actions are:
  subagent { agent: "wp", task: "Run the next todo unit in ledger/PLAN.md" }
...then read ONLY the returned summary, and dispatch the next one. Never
read a diff, a report file, or source.

Stop when PLAN.md has no todo units, or when wp returns a blocked verdict
twice in a row.
```

Recovery order for the ledger is stable-before-volatile:
`GOAL -> PLAN -> LEDGER (tail) -> CONTEXT -> task file`. `CONTEXT.md` is
rewritten every unit, so reading it earlier would invalidate everything
behind it in the server's prefix cache and make each fresh `wp`
re-prefill its whole preamble.

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

Removing a spec from plugins.nix changes what is *seeded*; it does not
uninstall. A container that ran an earlier plugin set needs one
`pi remove <spec>` per dropped package, or a rebuild from scratch. Check
`~/.pi/agent/npm/node_modules` afterwards.

A bad release? Pin it down for the interim: add a version to the pi spec
in modules/devbox/plugins.nix and rebuild. The claude plugin id carries
no version slot (its version is pinned by the official marketplace) - the
claude-side lever is temporarily removing the enabledPlugins entry in
modules/devbox/container.nix.
