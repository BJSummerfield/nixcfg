# Agent plugin membership for the devbox containers - which plugins the
# agents run, and nothing else. No versions, no refs, no hashes: nothing
# version-shaped here can go stale while you rebuild something unrelated.
# pi and claude both float to whatever their update commands reach, and a
# rebuild re-seeds these specs but never pins a version - so a live update
# persists across rebuilds instead of being undone by them.
#
# Update a running container (manual - see ENVIRONMENT.md):
#   pi:      pi update --extensions       (latest npm packages)
#   claude:  claude plugin update
#             (follows the official marketplace's current pin)
#
# Escalation, if a bad release lands: pin it down for the interim by
# adding a version to a pi spec below (e.g. "npm:pi-web-access@0.26.0")
# and rebuild - pi reinstalls an npm package whose installed version
# stops matching. The claude plugin id has no version slot - its version
# is pinned by the official marketplace - so the claude-side lever is
# temporarily removing the enabledPlugins entry from container.nix.
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

  # claude's plugin, for settings.json's enabledPlugins (devbox/
  # container.nix). Independent of the pi side above: dropping pi's
  # superpowers does not touch claude's, which is a different plugin for
  # a different agent. The id carries no version, so it cannot go stale.
  # The plugin state itself - marketplace clone, plugin cache,
  # installed_plugins.json - is claude-owned: installed and updated by
  # claude, never fetched or seeded by nix.
  claudePluginId = "superpowers@claude-plugins-official";
}
