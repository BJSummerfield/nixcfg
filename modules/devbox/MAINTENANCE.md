# Devbox maintenance

Operator notes for the devbox containers: updating the agent plugins, and
cleaning up after one that has been removed.

Deliberately not ENVIRONMENT.md. That file is `--append-system-prompt` for
claude and `~/.pi/agent/APPEND_SYSTEM.md` for pi, so everything in it is
paid for in every session of both agents; it is kept to facts about the
environment. Nothing here is injected anywhere.

## What a rebuild does, and what it leaves behind

Nix declares plugin *membership* - which plugins, no versions - in
plugins.nix, and seeds it into each agent's settings. A rebuild re-asserts
which plugins should be there.

It never uninstalls. Dropping a spec changes what is *seeded*; the files an
earlier install wrote stay exactly where they were. Nothing prunes them
later either: pi has no reconciliation pass that removes packages missing
from settings, so `pi remove` is the only path, and it is manual.

A leftover is usually inert. It is not inert when two packages register the
same tool name - then the one you removed is still in the registry,
colliding with the one you kept. That is the case worth checking after any
plugin swap.

## Updating agent plugins

pi runs `pi-subagents` and `pi-web-access`; Claude runs its own Superpowers
plugin, which is unrelated to either. Versions float - nothing
version-shaped is in nix, so nothing can go stale between rebuilds - and a
running container is updated with:

- pi: `pi update --extensions` - latest npm packages.
- Claude: `claude plugin update` - follows the official marketplace's
  current pin.

Updates persist across rebuilds: a rebuild re-seeds the membership specs
and the role tiering, never the versions.

A fresh container gets the pi plugins on pi's first start. Claude needs a
one-time bootstrap:

```
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official
```

The seeded `enabledPlugins` entry then turns it on.

A bad release? Pin it for the interim: add a version to the pi spec in
plugins.nix and rebuild. The claude plugin id has no version slot - its
version is pinned by the marketplace - so the claude-side lever is
temporarily removing the `enabledPlugins` entry in container.nix.

## Removing a pi plugin

**Order matters.** Nix rewrites `~/.pi/agent/settings.json` on every
activation and pi installs anything missing at startup, so deleting files
first just means the next rebuild re-seeds the spec and pi reinstalls it.

1. Drop the spec from `piPackages` in plugins.nix.
2. Rebuild the host, so the seeded settings.json stops listing it.
3. In the container, delete what the install wrote:

   ```
   pi remove npm:@teelicht/pi-superagents
   pi remove git:github.com/obra/superpowers
   ```

4. Check nothing survived, and that no tool name is now served twice:

   ```
   ls ~/.pi/agent/npm/node_modules ~/.pi/agent/npm/node_modules/@* 2>/dev/null
   ls ~/.pi/agent/git
   pi list
   ```

5. Restart pi.

Where pi keeps package state, for when a `pi remove` fails and you have to
look by hand:

| | |
|---|---|
| npm packages | `~/.pi/agent/npm/node_modules/<name>` (scoped ones nest: `@scope/name`) |
| git packages | `~/.pi/agent/git/` |
| per-extension config | `~/.pi/agent/extensions/<name>/` |

`pi remove` does not touch an extension's own config directory. The
`subagent` one is nix-managed - see pi-coding-agent/home.nix, whose
activation also sweeps the mode-444 `config.json.bak-*` files that
pi-superagents' install migration left behind on every start. Any other
extension's directory needs a manual `rm -rf`.

## Removing the claude plugin

Claude's plugin state is claude-owned: the marketplace clone, the plugin
cache and `installed_plugins.json` under `$CLAUDE_CONFIG_DIR`
(`/home/agent/.claude-state`). Nix never wrote any of it and will not clean
it.

Removing the `enabledPlugins` entry in container.nix only *disables* the
plugin - the files stay. To actually remove it:

```
claude plugin uninstall superpowers@claude-plugins-official
claude plugin marketplace remove claude-plugins-official   # if nothing else uses it
claude plugin prune                                        # auto-installed deps nothing needs
claude plugin list                                         # verify
```

## Starting over

The clean-slate option is destroying the container root
(`/var/lib/nixos-containers/<name>`) and letting the next rebuild recreate
it. That is genuinely clean - every path above is inside it.

It also destroys `/home/agent`, `/home/agent/projects` and
`/var/lib/paseo/worktrees`, none of which are bind-mounted from the host or
backed up by anything. Push first. The tailnet identity survives, since
`/var/lib/tailscale` *is* bind-mounted to `/var/lib/tailscale-<name>` on
the host.
