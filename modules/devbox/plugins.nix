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
# Removing a plugin and cleaning up after it: see docs/devbox-plugins.md.
{
  # Consumed by pi-coding-agent/settings.nix, which seeds
  # ~/.pi/agent/settings.json's `packages` from `piPackages` below.
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
  # forbids the exact shape we build on.
  #
  # pi-web-access is load-bearing beyond itself: the bundled `researcher`
  # agent is written around its web_search/fetch_content tools, so dropping it
  # breaks that agent rather than just removing a capability.
  piPackages = [
    "npm:pi-subagents"
    "npm:pi-web-access"
  ];
}
