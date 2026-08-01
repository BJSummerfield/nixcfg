# Host-side agent launcher: each invocation grabs an idle instance from
# the pool, bind-mounts only the caller's cwd into it, runs the agent, and
# stops the instance (discarding its root) when the session ends. Agents
# are thereby isolated from each other's projects.
#
# Sourced into a writeShellScriptBin by nixos.nix, which defines
# $instances (space-separated slot names), $max_instances, $agent_cmd and
# optionally $state_src/$state_dest (a host dir bind-mounted in for agents
# that need persistent state, e.g. claude's login).

case "${1:-}" in
  stop)
    for c in $instances; do
      sudo systemctl stop "container@$c" 2>/dev/null || true
    done
    exit 0
    ;;
esac

# Serialize slot selection so concurrent launches can't grab the same
# idle instance.
exec 9>/tmp/.coding-agents-launcher.lock
flock 9
slot=""
for c in $instances; do
  if ! systemctl is-active --quiet "container@$c"; then
    slot="$c"
    break
  fi
done
if [ -z "$slot" ]; then
  echo "all $max_instances agent sandboxes are busy; close one or raise mine.system.coding-agents.instances" >&2
  exit 1
fi
sudo systemctl start "container@$slot"
flock -u 9

# Wait for the instance to register with machined and finish booting.
for _ in $(seq 1 100); do
  state=$(sudo systemctl -M "$slot" is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  sleep 0.2
done

# Mirror the host path relative to $HOME so two projects with the same
# basename can never collide on a mount point.
rel="${PWD#"${HOME}"/}"
if [ "$rel" = "$PWD" ]; then
  rel="external/$(basename "$PWD")"
fi
dest="/home/agent/$rel"
sudo machinectl bind --mkdir "$slot" "$PWD" "$dest"

if [ -n "$state_src" ]; then
  mkdir -p "$state_src"
  sudo machinectl bind --mkdir "$slot" "$state_src" "$state_dest"
fi

args=""
if [ "$#" -gt 0 ]; then
  args=$(printf '%q ' "$@")
fi
trap 'sudo systemctl stop "container@$slot" 2>/dev/null || true' EXIT
sudo machinectl shell "agent@$slot" /bin/sh -lc "cd \"$dest\" && exec $agent_cmd $args"
