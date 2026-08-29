# Agent plugin membership for the devbox containers - no versions, no
# refs, no hashes: nothing version-shaped here can go stale while
# rebuilding something unrelated. pi and claude float to whatever their
# update commands reach; a rebuild re-seeds the specs but never pins, so
# a live update persists across rebuilds.
#
# Update a running container (manual - see ENVIRONMENT.md):
#   pi:      pi update --extensions
#   claude:  claude plugin update
#
# Escalation if a bad release lands: pin a pi spec below (e.g.
# "npm:pi-web-access@0.26.0" or "git:github.com/obra/superpowers@v6.3.0")
# and rebuild - a git pin needs one `pi update --extensions` to move the
# existing clone. The claude id has no version slot; its lever is
# removing the enabledPlugins entry from container.nix.
{
  # pi's package specs, seeded into ~/.pi/agent/settings.json via
  # pi-coding-agent/settings.nix. Unpinned on purpose: pi resolves the
  # registry / default branch at install time, so a fresh container gets
  # the latest on pi's first start.
  piPackages = [
    # Upstream superpowers straight from git, not an npm fork.
    "git:github.com/obra/superpowers"
    "npm:@teelicht/pi-superagents"
    "npm:pi-web-access"
  ];

  # claude's plugin, for settings.json's enabledPlugins (container.nix).
  # The id carries no version, so it cannot go stale. Plugin state
  # (marketplace clone, plugin cache, installed_plugins.json) is
  # claude-owned: installed and updated by claude, never seeded by nix.
  claudePluginId = "superpowers@claude-plugins-official";
}
