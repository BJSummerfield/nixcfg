# Agent plugin membership for the devbox containers - which plugins the
# agents run, and nothing else. No versions, no refs, no hashes: nothing
# version-shaped here can go stale while you rebuild something unrelated.
# pi floats to whatever its update command reaches, and a rebuild re-seeds
# these specs but never pins a version - so a live update persists across
# rebuilds instead of being undone by them.
#
# Update a running container (manual):
#   pi update --extensions      (latest npm packages)
#
# Escalation, if a bad release lands: pin it down for the interim by
# adding a version to a spec below (e.g. "npm:pi-web-access@0.26.0") and
# rebuild - pi reinstalls an npm package whose installed version stops
# matching.
#
# REMOVING ONE, AND CLEANING UP AFTER IT
#
# A rebuild re-asserts which plugins should be here. It never uninstalls:
# dropping a spec changes what is *seeded*, and the files an earlier
# install wrote stay on disk. Nothing prunes them later either - pi has no
# pass that removes packages missing from settings, so `pi remove` is the
# only path and it is manual.
#
# A leftover is usually inert. It is not inert when two packages register
# the same tool name, which is what the pi-superagents -> pi-subagents
# swap ran into: both provide `subagent`.
#
# Order matters, because nix rewrites ~/.pi/agent/settings.json on every
# activation and pi installs anything missing at startup - delete the
# files first and the next rebuild just invites the package back:
#
#   1. drop the spec below, and rebuild the host
#   2. in the container:  pi remove npm:@teelicht/pi-superagents
#                         pi remove git:github.com/obra/superpowers
#   3. check:  ls ~/.pi/agent/npm/node_modules ~/.pi/agent/git && pi list
#   4. restart pi
#
# If a `pi remove` fails, the state is under ~/.pi/agent: npm packages in
# npm/node_modules/<name> (scoped ones nest as @scope/name), git packages
# in git/, and each extension's own config in extensions/<name>/. That
# last one is not touched by `pi remove` and needs a manual rm - including
# extensions/subagent/, where pi-superagents left a config.json plus the
# mode-444 config.json.bak-<timestamp> files its install migration wrote
# on every start.
{
  # pi's package specs, seeded into ~/.pi/agent/settings.json via
  # pi-coding-agent/settings.nix. Unpinned on purpose: pi resolves the
  # registry at install time, so a fresh container gets the latest of
  # both on pi's first start, and `pi update --extensions` is the
  # float-to-latest command.
  #
  # pi-subagents is the delegation engine. It is upstream (nicobailon),
  # not the @teelicht/pi-superagents fork we ran before: that fork's only
  # WorkflowMode is "superpowers", and its policy layer strips the
  # `subagent` tool from any agent whose name starts with `sp-`, so a
  # sub-orchestrator could only exist there by dodging a string check.
  # Upstream makes nesting a documented frontmatter field
  # (allowNestedSubagents) and ships scout/researcher/worker/reviewer/
  # oracle/delegate as builtins. Not @gotgenes/pi-subagents: that one
  # strips the delegation tools from every child unconditionally, which
  # forbids the exact shape we build on (see
  # docs/superpowers/specs/2026-08-31-nested-orchestrator-plan.md).
  #
  # Same author as pi-web-access, which is why the bundled `researcher`
  # is already written around its web_search / fetch_content tools.
  piPackages = [
    "npm:pi-subagents"
    "npm:pi-web-access"
  ];
}
