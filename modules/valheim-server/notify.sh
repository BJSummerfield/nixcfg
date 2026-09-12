# Valheim event notifier: parses the server's journal for join/leave/version
# events and turns systemd stop reasons into chat messages.
#
# Subcommands:
#   parse   Pure. Reads journal message lines on stdin, prints one event per
#           line to stdout: "up VERSION", "join STEAMID NAME (N online)",
#           "leave STEAMID NAME (N online)", "mismatch THEIRS MINE". No
#           side effects, no env required. Used by the parser check.
#   watch   Follows the current valheim.service invocation's journal live,
#           replaying anything already logged silently, then posts new
#           events. Exits once the invocation it is following stops being
#           current (id changed, or the server is no longer active); it is
#           restarted by valheim.service's ExecStartPost on every start.
#   stopped Meant as valheim.service's `ExecStopPost=+`. Reads $SERVICE_RESULT
#           (and $EXIT_STATUS for the crash case) and turns the stop into a
#           message, unless it was a self-inflicted update restart (recorded
#           by the updater in state/stop-reason), which the updater announces
#           itself. Stops post whether or not anyone is online, so the chat
#           always shows the server's status.
#
# Env contract for `watch` and `stopped` (not required by `parse`):
#   VALHEIM_INSTALL     Install root; state lives at $VALHEIM_INSTALL/state.
#   VALHEIM_WORLD       World name, used in the plain "up" message.
#   VALHEIM_NOTIFY_SEND Path to a keybase-notify binary, already baked with
#                       the in-container URL file path.
#
# State files under $VALHEIM_INSTALL/state (all root-owned; the container's
# valheim-notify.service and the updater both run as root):
#   stop-reason      Written by the updater's cmd_swap before it stops the
#                    server for an update; read and deleted by `stopped`.
#   last-stop        Written by `stopped`: "update", "planned", "timeout" or
#                    "crash". Read and deleted by the next `up` event, to word
#                    its message ("back up after the crash", "back up on
#                    version X").
#   last-version     Last version `up` saw, to word "back up on version X
#                    (was Y)" after an update.
#   notify-crash-at  mtime is the last time a crash was posted, so repeated
#                    crash-restart-crash loops don't spam more than once
#                    every 10 minutes.
#
# Every post is wrapped in `timeout 25` and closes fd 9 (`9>&-`) so it can
# never fail or hang whatever holds the updater's lock, and a failure is
# logged and ignored rather than propagated.

log() {
  echo "valheim-notify: $*"
}

# Only `watch` and `stopped` need these; `parse` must run without any of
# them set, for the parser check.
require_service_env() {
  : "${VALHEIM_INSTALL:?VALHEIM_INSTALL must be set}"
  : "${VALHEIM_WORLD:?VALHEIM_WORLD must be set}"
  : "${VALHEIM_NOTIFY_SEND?VALHEIM_NOTIFY_SEND must be set (empty string for none)}"
  STATE="$VALHEIM_INSTALL/state"
}

# Atomic root-owned write, tmp+rename so a reader never sees a partial file.
write_state() {
  local name="$1" content="$2" tmp
  tmp=$(mktemp "$STATE/.${name}.XXXXXX") || return 1
  if ! { printf '%s' "$content" >"$tmp" && mv -f "$tmp" "$STATE/$name"; }; then
    rm -f "$tmp"
    return 1
  fi
}

read_state() {
  local name="$1"
  if [[ -f "$STATE/$name" ]]; then
    cat "$STATE/$name"
  fi
}

post() {
  local msg="$1"
  if [[ -z "${VALHEIM_NOTIFY_SEND:-}" ]]; then
    log "not posted (no sender configured): $msg"
    return 0
  fi
  timeout 25 "$VALHEIM_NOTIFY_SEND" "$msg" 9>&- || log "post failed (ignored): $msg"
}

current_invocation_id() {
  local id
  id=$(systemctl show -p InvocationID --value valheim.service)
  if [[ -z "$id" || "$id" =~ ^0*$ ]]; then
    return 1
  fi
  printf '%s' "$id"
}

still_current() {
  local id="$1" cur
  systemctl is-active --quiet valheim.service || return 1
  cur=$(systemctl show -p InvocationID --value valheim.service)
  [[ "$cur" == "$id" ]]
}

# --- parser -----------------------------------------------------------
#
# Patterns are not anchored at the start; they only need to occur somewhere
# in the line, so a `journalctl -o short-unix` timestamp/unit prefix ahead
# of the message doesn't matter.
PLAYER_HIST_RE='Player history entry with index [0-9]+: +(.+) \(Steam_([0-9]+),'
VERSION_RE='Valheim version: ([^ ]+)'
UP_RE='Game server connected'
CONN_RE='Got connection SteamID ([0-9]+)'
MISMATCH_RE='Network version check, their:([0-9]+), mine:([0-9]+)'
ZDOID_RE='Got character ZDOID from (.+) : (-?[0-9]+):([0-9]+)[[:space:]]*$'
CLOSE_RE='Closing socket ([0-9]+)'

# Operates on the caller's (dynamically scoped, via `local`) STEAM_NAME,
# JOINED_NAME, PENDING, VERSION and UP_EMITTED, and leaves any events fired
# by this one line in the global EVENTS array. Shared by `parse` (which
# just prints EVENTS) and `watch` (which also decides whether to post them).
parse_events_from_line() {
  local line="$1"
  EVENTS=()

  if [[ "$line" =~ $PLAYER_HIST_RE ]]; then
    STEAM_NAME["${BASH_REMATCH[2]}"]="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ $VERSION_RE ]]; then
    VERSION="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ $UP_RE ]]; then
    if ((UP_EMITTED == 0)); then
      EVENTS+=("up $VERSION")
      UP_EMITTED=1
    fi
  elif [[ "$line" =~ $CONN_RE ]]; then
    PENDING+=("${BASH_REMATCH[1]}")
  elif [[ "$line" =~ $MISMATCH_RE ]]; then
    local theirs="${BASH_REMATCH[1]}" mine="${BASH_REMATCH[2]}"
    if [[ "$theirs" != "$mine" ]]; then
      EVENTS+=("mismatch $theirs $mine")
      # A version mismatch means the connection that was just pending never
      # gets a ZDOID: drop the most recently added pending id, a failed join.
      if ((${#PENDING[@]} > 0)); then
        unset "PENDING[$((${#PENDING[@]} - 1))]"
        PENDING=("${PENDING[@]}")
      fi
    fi
  elif [[ "$line" =~ $ZDOID_RE ]]; then
    local name="${BASH_REMATCH[1]}" id_hi="${BASH_REMATCH[2]}"
    if [[ "$id_hi" != "0" ]]; then
      # Not fixed: two players sharing the same character name are
      # indistinguishable here, so a respawn from either can be mistaken for
      # the other's already-joined name.
      local already=0 k
      for k in "${!JOINED_NAME[@]}"; do
        if [[ "${JOINED_NAME[$k]}" == "$name" ]]; then
          already=1
          break
        fi
      done
      if ((already == 0)) && ((${#PENDING[@]} > 0)); then
        local sid="${PENDING[0]}"
        PENDING=("${PENDING[@]:1}")
        JOINED_NAME["$sid"]="$name"
        EVENTS+=("join $sid $name (${#JOINED_NAME[@]} online)")
      fi
    fi
  elif [[ "$line" =~ $CLOSE_RE ]]; then
    local sid="${BASH_REMATCH[1]}"
    if [[ -n "${JOINED_NAME[$sid]+x}" ]]; then
      local display="${JOINED_NAME[$sid]}"
      unset "JOINED_NAME[$sid]"
      if [[ -z "$display" ]]; then
        display="${STEAM_NAME[$sid]:-a player}"
      fi
      EVENTS+=("leave $sid $display (${#JOINED_NAME[@]} online)")
    else
      local kept=() p dropped=0
      for p in "${PENDING[@]}"; do
        if ((dropped == 0)) && [[ "$p" == "$sid" ]]; then
          dropped=1
          continue
        fi
        kept+=("$p")
      done
      PENDING=("${kept[@]}")
    fi
  fi
}

cmd_parse() {
  local -A STEAM_NAME=() JOINED_NAME=()
  local -a PENDING=()
  local VERSION="" UP_EMITTED=0
  local line ev
  while IFS= read -r line; do
    parse_events_from_line "$line"
    for ev in "${EVENTS[@]}"; do
      echo "$ev"
    done
  done
}

# --- watch --------------------------------------------------------------

handle_up() {
  local version="$1"
  local last_stop last_version msg

  last_stop=$(read_state last-stop)
  rm -f "$STATE/last-stop"
  # A last-stop written by an older build has a second field; only the
  # reason matters.
  last_stop=${last_stop%% *}
  last_version=$(read_state last-version)

  case "$last_stop" in
    crash)
      msg="✅ Valheim is back up after the crash ($version)"
      ;;
    update)
      if [[ -n "$last_version" && "$last_version" != "$version" ]]; then
        msg="✅ Valheim is back up on version *$version* (was $last_version)"
      else
        msg="✅ Valheim is back up on version *$version*"
      fi
      ;;
    *)
      msg="⚔️ Valheim server is up ($version, world $VALHEIM_WORLD)"
      ;;
  esac

  write_state last-version "$version"

  post "$msg"
}

handle_event() {
  local ev="$1" is_replay="$2"
  local kind rest
  read -r kind rest <<<"$ev"

  case "$kind" in
    up)
      ((is_replay)) && return 0
      handle_up "$rest"
      ;;
    join | leave)
      ((is_replay)) && return 0
      local name="a player" verb="left" icon="👋"
      if [[ "$rest" =~ ^[0-9]+\ (.+)\ \([0-9]+\ online\)$ ]]; then
        # Keybase renders chat markdown, so a name is bolded only when it
        # has no markdown characters of its own; backticks would open a
        # code span and are always dropped.
        name="${BASH_REMATCH[1]//\`/}"
        if [[ "$name" != *[*_~]* ]]; then
          name="*$name*"
        fi
      fi
      if [[ "$kind" == join ]]; then
        verb="joined"
        icon="🟢"
      fi
      post "$icon $name $verb Valheim (${#JOINED_NAME[@]} online)"
      ;;
    mismatch)
      ((is_replay)) && return 0
      local now theirs mine
      read -r theirs mine <<<"$rest"
      now=$(date +%s)
      if ((now - LAST_MISMATCH_POST >= 3600)); then
        post "⚠️ Someone tried to join on network version $theirs; the server is on $mine"
        LAST_MISMATCH_POST=$now
      fi
      ;;
  esac
}

cmd_watch() {
  require_service_env

  local -A STEAM_NAME=() JOINED_NAME=()
  local -a PENDING=()
  local VERSION="" UP_EMITTED=0 LAST_MISMATCH_POST=0
  local start id
  start=$(date +%s)
  if ! systemctl is-active --quiet valheim.service; then
    log "watch: valheim.service is not active, exiting"
    return 0
  fi
  if ! id=$(current_invocation_id); then
    log "watch: no valid InvocationID for valheim.service, exiting"
    return 0
  fi
  log "watch: following invocation $id"

  exec 3< <(journalctl -f -n all -o short-unix "_SYSTEMD_INVOCATION_ID=$id")

  local line rc ts is_replay ev
  while true; do
    if IFS= read -r -t 60 -u 3 line; then
      ts="${line%% *}"
      ts="${ts%%.*}"
      is_replay=0
      if [[ "$ts" =~ ^[0-9]+$ ]] && ((ts < start)); then
        is_replay=1
      fi
      parse_events_from_line "$line"
      for ev in "${EVENTS[@]}"; do
        handle_event "$ev" "$is_replay"
      done
    else
      rc=$?
      # bash read's -t timeout exit status is >128; anything lower here
      # means the journalctl process behind fd 3 actually ended (EOF), which
      # should not normally happen while it is following the journal. Exit 1
      # so Restart=on-failure brings the watcher back; a clean end-of-service
      # exits 0 below instead.
      if ((rc < 128)); then
        log "watch: journal stream ended unexpectedly, exiting"
        return 1
      fi
    fi
    if ! still_current "$id"; then
      log "watch: invocation no longer current, exiting"
      return 0
    fi
  done
}

# --- stopped (ExecStopPost) ----------------------------------------------

crash_throttled() {
  local last
  last=$(read_state notify-crash-at)
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  (($(date +%s) - last < 600))
}

cmd_stopped() {
  require_service_env

  local reason=""
  if [[ -f "$STATE/stop-reason" ]]; then
    reason=$(read_state stop-reason)
    rm -f "$STATE/stop-reason"
  fi

  local result="${SERVICE_RESULT:-unknown}"
  local write_reason="" msg=""

  if [[ "$result" == success && "$reason" == update ]]; then
    write_reason=update
  elif [[ "$result" == success ]]; then
    write_reason=planned
    msg="🔴 Valheim server stopped"
  elif [[ "$result" == timeout ]]; then
    write_reason=timeout
    msg="⚠️ Valheim server was shut down before it finished saving; the last few minutes of play may be lost"
  else
    write_reason=crash
    if crash_throttled; then
      log "crash detected but suppressed (posted within the last 10 minutes): result=$result exit_status=${EXIT_STATUS:-unknown}"
    else
      log "crash detected: result=$result exit_status=${EXIT_STATUS:-unknown}"
      msg="💥 *Valheim server crashed*; it will try to restart on its own"
      write_state notify-crash-at "$(date +%s)"
    fi
  fi

  # Written before the post, so a hung post can't lose it.
  write_state last-stop "$write_reason"

  if [[ -n "$msg" ]]; then
    post "$msg"
  fi
}

usage() {
  echo "usage: valheim-notify {parse|watch|stopped}" >&2
  exit 1
}

case "${1:-}" in
  parse) cmd_parse ;;
  watch) cmd_watch ;;
  stopped) cmd_stopped ;;
  *) usage ;;
esac
