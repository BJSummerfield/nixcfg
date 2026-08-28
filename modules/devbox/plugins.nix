# Agent plugin membership for the devbox containers - which plugins the
# agents run, and nothing else. No versions, no refs, no hashes: nothing
# version-shaped here can go stale while you rebuild something unrelated.
# pi and claude both float to whatever their update commands reach, and a
# rebuild re-seeds these specs but never pins a version - so a live update
# persists across rebuilds instead of being undone by them.
#
# Update a running container (manual - see ENVIRONMENT.md):
#   pi:      pi update --extensions
#             (latest npm packages; moves the superpowers clone to the
#             default branch's HEAD)
#   claude:  claude plugin update
#             (follows the official marketplace's current pin)
#
# Escalation, if a bad release lands: pin it down for the interim by
# adding a version or ref to a pi spec below (e.g.
# "npm:pi-web-access@0.26.0" or "git:github.com/obra/superpowers@v6.3.0")
# and rebuild. pi reinstalls an npm package whose installed version
# stops matching; a git pin then needs one `pi update --extensions` to
# move the existing clone. The claude plugin id has no version slot -
# its version is pinned by the official marketplace - so the claude-side
# lever is temporarily removing the enabledPlugins entry from
# container.nix.
{
  # pi's package specs, seeded into ~/.pi/agent/settings.json via
  # pi-coding-agent/settings.nix. Unpinned on purpose: pi resolves the
  # registry / the default branch at install time, so a fresh container
  # gets the latest of all three on pi's first start, and
  # `pi update --extensions` is the float-to-latest command.
  piPackages = [
    # Upstream superpowers straight from git, not an npm fork.
    "git:github.com/obra/superpowers"
    "npm:@teelicht/pi-superagents"
    "npm:pi-web-access"
  ];

  # claude's plugin, for settings.json's enabledPlugins (devbox/
  # container.nix). The id carries no version, so it cannot go stale. The
  # plugin state itself - marketplace clone, plugin cache,
  # installed_plugins.json - is claude-owned: installed and updated by
  # claude, never fetched or seeded by nix.
  claudePluginId = "superpowers@claude-plugins-official";
}
