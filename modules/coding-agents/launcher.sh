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

# The in-container agent user must match the caller's uid for bind-mounted
# files to be writable; uids are auto-allocated per host, so flag the
# mismatch before wasting a session on it.
if [ "$(id -u)" != "$agent_uid" ]; then
  echo "WARNING: you are uid $(id -u) but the sandbox agent runs as uid $agent_uid;" >&2
  echo "WARNING: your files will not be writable inside. Set mine.system.coding-agents.agentUid = $(id -u); for this host." >&2
fi

# Serialize slot selection so concurrent launches can't grab the same
# idle instance.
exec 9>/tmp/.coding-agents-launcher.lock
flock 9
slot=""
for c in $instances; do
  # A slot is free only when fully stopped. "deactivating" (a session
  # that just ended) still has the old machine registered with machined,
  # and starting/binding against it races the shutdown - binds can land
  # in the dying instance while the shell reaches the fresh one.
  state=$(systemctl show -P ActiveState "container@$c" 2>/dev/null || echo unknown)
  if [ "$state" = "inactive" ] || [ "$state" = "failed" ]; then
    slot="$c"
    break
  fi
done
if [ -z "$slot" ]; then
  echo "all $max_instances agent sandboxes are busy; close one or raise mine.system.coding-agents.instances" >&2
  exit 1
fi
sudo systemctl start "container@$slot"
# From here the slot is ours to clean up: register the trap before the
# binds, and on signals too, so a failed bind or a closed terminal can't
# leak a running container.
trap 'sudo systemctl stop "container@$slot" 2>/dev/null || true' EXIT HUP INT TERM
flock -u 9

# Wait for the instance to register with machined and finish booting.
booted=""
for _ in $(seq 1 100); do
  state=$(sudo systemctl -M "$slot" is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) booted=1; break ;; esac
  sleep 0.2
done
if [ -z "$booted" ]; then
  echo "agent container $slot did not finish booting" >&2
  exit 1
fi

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
# The in-container preamble warns loudly when the agent can't write where
# it must: an unwritable project dir means the agent silently builds in
# its ephemeral home (discarded on stop), an unwritable state dir means
# logins don't survive the session.
#
# machinectl propagates COLORTERM by itself; ssh is what loses it. TERM rides
# the pty request in the protocol, COLORTERM is an ordinary variable needing
# SendEnv/AcceptEnv, so a session launched from an ssh login arrives without
# it and the agents quantize their themes into the 256-colour cube. The
# fallback assumes a truecolor client, which every terminal here is.
sudo machinectl shell --setenv=COLORTERM="${COLORTERM:-truecolor}" "agent@$slot" /bin/sh -lc "
  cd \"$dest\" || exit 1
  if [ ! -w . ]; then
    echo \"WARNING: $dest is not writable by the agent user (uid \$(id -u), groups: \$(id -Gn)).\" >&2
    echo \"WARNING: anything the agent writes outside it is DISCARDED when the session ends.\" >&2
  fi
  if [ -n \"$state_dest\" ] && [ ! -w \"$state_dest\" ]; then
    echo \"WARNING: $state_dest is not writable; login/config state will not survive this session.\" >&2
  fi
  exec $agent_cmd $args"
