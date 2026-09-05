# Devbox pi plugin membership: semantics and removal runbook

Status: accurate as of 2026-09-05, describes `modules/devbox/plugins.nix`.

`modules/devbox/plugins.nix` declares which `pi` plugins run in the devbox
containers — membership only, no versions, refs, or hashes. That file has the
current list and the short rationale for why nothing version-shaped lives
there; this doc covers the operational parts: how removal actually works and
what to clean up by hand when it doesn't.

## Removing a plugin, and cleaning up after it

A rebuild re-asserts which plugins should be here. It never uninstalls:
dropping a spec changes what is *seeded*, and the files an earlier install
wrote stay on disk. Nothing prunes them later either — pi has no pass that
removes packages missing from settings, so `pi remove` is the only path and
it is manual.

A leftover is usually inert. It is not inert when two packages register the
same tool name, which is what the pi-superagents -> pi-subagents swap ran
into: both provide `subagent`.

Order matters, because nix rewrites `~/.pi/agent/settings.json` on every
activation and pi installs anything missing at startup — delete the files
first and the next rebuild just invites the package back:

1. drop the spec from `piPackages` in `modules/devbox/plugins.nix`, and rebuild
   the host
2. in the container:
   ```
   pi remove npm:@teelicht/pi-superagents
   pi remove git:github.com/obra/superpowers
   ```
3. check: `ls ~/.pi/agent/npm/node_modules ~/.pi/agent/git && pi list`
4. restart pi

If a `pi remove` fails, the state is under `~/.pi/agent`: npm packages in
`npm/node_modules/<name>` (scoped ones nest as `@scope/name`), git packages
in `git/`, and each extension's own config in `extensions/<name>/`. That
last one is not touched by `pi remove` and needs a manual `rm` — including
`extensions/subagent/`, where pi-superagents left a `config.json` plus the
mode-444 `config.json.bak-<timestamp>` files its install migration wrote on
every start.

See [`modules/devbox/plugins.nix`](../modules/devbox/plugins.nix) for the
current plugin list and the no-versions rationale.
