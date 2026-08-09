# Runtime PATH additions for pi, shared by every place that builds a pi
# binary. Kept here rather than inline at each call site because the devbox
# container cannot use the home-manager module's `extraPackages` (it sets
# programs.pi-coding-agent.package = null to dodge a profile collision, and a
# null package silently drops extraPackages), so it re-wraps pi itself - two
# lists that must never disagree.
#
# bun runs pi's package installs (settings.npmCommand; see the comment there
# for why not npm). Without it pi aborts at startup with
# `Error: spawn bun ENOENT` the moment it tries to install a declared package.
# nodejs is for anything that shells out to node at runtime.
pkgs: [
  pkgs.nodejs
  pkgs.bun
]
