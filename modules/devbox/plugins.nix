# Updating a plugin: bump its version below and rebuild the host. pi installs
# the pinned version at its next start; `pi list` in the container shows what
# is installed. If the old version survives the rebuild:  pi update --extensions
#
# Removing a plugin:
#   1. drop the spec below, and rebuild the host
#   2. in the container:  pi remove npm:<name>
#   3. check:  ls ~/.pi/agent/npm/node_modules && pi list
#   4. restart pi
#
# If `pi remove` fails, manually rm ~/.pi/agent/npm/node_modules/<name>.
{
  # pi-subagents is currently vendored (build-time patched for scene_gen #153);
  # see modules/pi-coding-agent/home.nix. Its version pin lives in
  # modules/pi-coding-agent/pi-subagents-patched.nix.
  piPackages = [ "npm:pi-web-access@0.40.0" ];
}
