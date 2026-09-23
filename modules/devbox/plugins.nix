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
  piPackages = [
    "npm:pi-subagents@0.71.0"
    "npm:pi-web-access@0.31.0"
  ];
}
