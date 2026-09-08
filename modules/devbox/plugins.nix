# Update a running container (manual):
#   pi update --extensions
#
# Removing a plugin (manual cleanup):
#   1. drop the spec below, and rebuild the host
#   2. in the container:  pi remove npm:@teelicht/pi-superagents
#                         pi remove git:github.com/obra/superpowers
#   3. check:  ls ~/.pi/agent/npm/node_modules ~/.pi/agent/git && pi list
#   4. restart pi
#
# If `pi remove` fails, manually rm under ~/.pi/agent: npm/node_modules/<name>,
# git/, and extensions/<name>/.
{
  piPackages = [
    "npm:pi-subagents"
    "npm:pi-web-access"
  ];
}
