# Valheim event notifier: parses the server's journal for join/leave/version/
# death events and turns systemd stop reasons into chat messages.
#
# Subcommands:
#   parse         Pure. Reads journal message lines on stdin, prints one
#                 event per line to stdout: "up VERSION",
#                 "join STEAMID NAME (N online)",
#                 "leave STEAMID NAME (N online)", "mismatch THEIRS MINE",
#                 "death NAME". No side effects, no env required. Used by
#                 the parser check.
#   watch         Follows the current valheim.service invocation's journal
#                 live, replaying anything already logged silently, then
#                 posts new events. Exits once the invocation it is
#                 following stops being current (id changed, or the server
#                 is no longer active); it is restarted by valheim.service's
#                 ExecStartPost on every start.
#   stopped       Meant as valheim.service's `ExecStopPost=+`. Reads
#                 $SERVICE_RESULT (and $EXIT_STATUS for the crash case) and
#                 turns the stop into a message, unless it was a
#                 self-inflicted update restart (recorded by the updater in
#                 state/stop-reason), which the updater announces itself.
#                 Stops post whether or not anyone is online, so the chat
#                 always shows the server's status.
#   death-message Pure. Prints the death-line template at INDEX (rotated
#                 modulo the number of usable lines), with NAME substituted
#                 in, to stdout. No side effects, no service env required;
#                 used by the death-message check to test rotation and
#                 substitution deterministically. Honors VALHEIM_DEATH_LINES
#                 the same way `watch` does (see load_death_lines below).
#
# Env contract for `watch` and `stopped` (not required by `parse` or
# `death-message`):
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
#   death-line-next  Index of the next death line to use, so rotation is
#                    sequential across restarts instead of resetting to 0.
#                    Written by `watch` after every death post; replays
#                    never advance it.
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

# Game-time stamp each server log line carries, e.g. "09/10/2026 20:41:27:".
# Unanchored, like the patterns above; only used on ZDOID lines, and only to
# measure deltas between them, so it runs in naive UTC regardless of the
# sandbox's or container's own time zone.
GAME_TS_RE='([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}):'

# Sets the caller's LINE_EPOCH to the game-time stamp on $1 as a Unix epoch,
# or "" if the line has none or the stamp fails to parse. Call only after
# copying any needed fields out of BASH_REMATCH from another regex match on
# the same line (this overwrites it). An empty LINE_EPOCH means the death
# guards below never fire for that line: safe by construction.
line_epoch() {
  LINE_EPOCH=""
  [[ "$1" =~ $GAME_TS_RE ]] || return 0
  LINE_EPOCH=$(TZ=UTC0 date -d "${BASH_REMATCH[3]}-${BASH_REMATCH[1]}-${BASH_REMATCH[2]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null) || LINE_EPOCH=""
}

# Death detection thresholds; see the ZDOID branch below. Real respawn
# counters observed in the wild: 1778-18290. Join-artifact "returns" (a 0:0
# right after a fresh join, before the character ever really existed) seen
# at counters 1-12, all within seconds of the 0:0. DEATH_MIN_COUNTER sits
# well below the smallest real sample and well above the largest artifact.
DEATH_MIN_SESSION_SECS=120 # 0:0 earlier than this after joining = join artifact
DEATH_RETURN_SECS=30       # the return must follow the 0:0 within this
DEATH_MIN_COUNTER=100      # return id_lo below this is treated as an artifact

# Operates on the caller's (dynamically scoped, via `local`) JOINED_NAME.
# True if NAME is any currently joined character. Not fixed: two players
# sharing the same character name are indistinguishable here, so a respawn
# from either can be mistaken for the other's already-joined name.
is_joined() {
  local name="$1" k
  for k in "${!JOINED_NAME[@]}"; do
    [[ "${JOINED_NAME[$k]}" == "$name" ]] && return 0
  done
  return 1
}

# Operates on the caller's (dynamically scoped, via `local`) STEAM_NAME,
# JOINED_NAME, PENDING, VERSION, UP_EMITTED, FIRST_SEEN, LAST_HI, DEATH_AT
# and DEATH_HI, and leaves any events fired by this one line in the global
# EVENTS array. Shared by `parse` (which just prints EVENTS) and `watch`
# (which also decides whether to post them).
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
    local name="${BASH_REMATCH[1]}" id_hi="${BASH_REMATCH[2]}" id_lo="${BASH_REMATCH[3]}"
    local now=""
    line_epoch "$line"
    now="$LINE_EPOCH"
    # set -u: never read the assoc arrays bare below; copy once into scalars.
    local fs="${FIRST_SEEN[$name]:-}" lh="${LAST_HI[$name]:-}"
    local dat="${DEATH_AT[$name]:-}" dhi="${DEATH_HI[$name]:-}"

    if [[ "$id_hi" == "0" && "$id_lo" == "0" ]]; then
      # A second 0:0 with no return in between restarts the pending record
      # rather than stacking; only the most recent 0:0 can ever fire.
      # shellcheck disable=SC2016
      unset -v 'DEATH_AT[$name]' 'DEATH_HI[$name]'
      if [[ -n "$now" && -n "$fs" && -n "$lh" ]] && is_joined "$name" \
        && ((now - fs >= DEATH_MIN_SESSION_SECS)); then
        DEATH_AT["$name"]="$now"
        DEATH_HI["$name"]="$lh"
      fi
      # A bare 0:0 is never itself an event; only its return line can be.
    elif [[ "$id_hi" != "0" ]]; then
      if [[ -n "$dat" ]]; then
        if [[ -n "$now" ]] && ((now - dat >= 0 && now - dat <= DEATH_RETURN_SECS)) \
          && [[ "$id_hi" == "$dhi" && "$id_lo" =~ ^[0-9]{1,9}$ ]] \
          && ((10#$id_lo >= DEATH_MIN_COUNTER)); then
          EVENTS+=("death $name")
        fi
        # shellcheck disable=SC2016
        unset -v 'DEATH_AT[$name]' 'DEATH_HI[$name]' # consumed either way
      fi
      LAST_HI["$name"]="$id_hi"

      if ! is_joined "$name" && ((${#PENDING[@]} > 0)); then
        local sid="${PENDING[0]}"
        PENDING=("${PENDING[@]:1}")
        JOINED_NAME["$sid"]="$name"
        [[ -n "$now" ]] && FIRST_SEEN["$name"]="$now"
        # shellcheck disable=SC2016
        unset -v 'DEATH_AT[$name]' 'DEATH_HI[$name]'
        EVENTS+=("join $sid $name (${#JOINED_NAME[@]} online)")
      fi
    fi
    # Any other id_hi == 0 line (nonzero id_lo alongside it) is a shape
    # we've never seen; ignored entirely, death state untouched, per the
    # never-misfire rule.
  elif [[ "$line" =~ $CLOSE_RE ]]; then
    local sid="${BASH_REMATCH[1]}"
    if [[ -n "${JOINED_NAME[$sid]+x}" ]]; then
      local display="${JOINED_NAME[$sid]}"
      local gone="$display"
      unset "JOINED_NAME[$sid]"
      if [[ -n "$gone" ]]; then
        # A logout clears this character's death-tracking state too, so a
        # rejoin restarts the DEATH_MIN_SESSION_SECS clock from zero.
        # shellcheck disable=SC2016
        unset -v 'FIRST_SEEN[$gone]' 'LAST_HI[$gone]' 'DEATH_AT[$gone]' 'DEATH_HI[$gone]'
      fi
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
  local -A FIRST_SEEN=() LAST_HI=() DEATH_AT=() DEATH_HI=()
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

: "${DEFAULT_DEATH_LINES:=}"

# Formats NAME for chat into the caller's FORMATTED_NAME: strips backticks
# (which would open a Keybase code span and always get dropped) and bolds
# it, unless it still contains markdown characters of its own. Shared by
# join/leave and death.
format_name() {
  local name="$1"
  FORMATTED_NAME="${name//\`/}"
  if [[ "$FORMATTED_NAME" != *[*_~]* ]]; then
    FORMATTED_NAME="*$FORMATTED_NAME*"
  fi
}

# Fills the caller's DEATH_LINES array from the death-line template file at
# $VALHEIM_DEATH_LINES, falling back to DEFAULT_DEATH_LINES baked in by
# notify-package.nix (the runtime override is for tests only). Keeps every
# non-blank, non-comment line that contains exactly one "{player}"; a file
# with nothing usable in it (missing, unreadable, empty) leaves DEATH_LINES
# with a single generic fallback, so a broken lines file can never crash a
# live death post.
load_death_lines() {
  local path="${VALHEIM_DEATH_LINES:-$DEFAULT_DEATH_LINES}"
  local -a raw=()
  DEATH_LINES=()
  if [[ -n "$path" && -r "$path" ]]; then
    mapfile -t raw <"$path"
  fi
  local l rest
  for l in "${raw[@]}"; do
    l="${l%$'\r'}"
    [[ -z "$l" || "$l" =~ ^[[:space:]]*# ]] && continue
    [[ "$l" == *"{player}"* ]] || continue
    # Exactly one occurrence: the text after the first one must not contain
    # another.
    rest="${l#*\{player\}}"
    [[ "$rest" == *"{player}"* ]] && continue
    DEATH_LINES+=("$l")
  done
  if ((${#DEATH_LINES[@]} == 0)); then
    DEATH_LINES=("{player} died")
  fi
}

# Renders DEATH_LINES[INDEX % count] for NAME into the caller's DEATH_MSG.
# Splits on the first "{player}" and substitutes literally rather than with
# bash's ${line//\{player\}/$name}: bash 5.2's patsub_replacement expands a
# `&` or backslash sequence in the replacement text, and a player name is
# untrusted input.
render_death_message() {
  local idx="$1" name="$2"
  local tmpl pre suffix
  idx=$((idx % ${#DEATH_LINES[@]}))
  tmpl="${DEATH_LINES[$idx]}"
  pre="${tmpl%%\{player\}*}"
  suffix="${tmpl#*\{player\}}"
  format_name "$name"
  DEATH_MSG="💀 $pre$FORMATTED_NAME$suffix"
}

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
        format_name "${BASH_REMATCH[1]}"
        name="$FORMATTED_NAME"
      fi
      if [[ "$kind" == join ]]; then
        verb="joined"
        icon="🟢"
      fi
      post "$icon $name $verb Valheim (${#JOINED_NAME[@]} online)"
      ;;
    death)
      ((is_replay)) && return 0
      local idx n=${#DEATH_LINES[@]}
      ((n > 0)) || return 0
      idx=$(read_state death-line-next) || idx=0
      [[ "$idx" =~ ^[0-9]{1,6}$ ]] || idx=0
      idx=$((10#$idx % n))
      render_death_message "$idx" "$rest"
      write_state death-line-next "$(((idx + 1) % n))" || true
      post "$DEATH_MSG"
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
  local -A FIRST_SEEN=() LAST_HI=() DEATH_AT=() DEATH_HI=()
  local -a PENDING=()
  local -a DEATH_LINES=()
  local VERSION="" UP_EMITTED=0 LAST_MISMATCH_POST=0
  local start id
  load_death_lines
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

# --- death-message (pure, for the death-lines/rotation checks) ----------

cmd_death_message() {
  local idx="${1:?usage: valheim-notify death-message INDEX NAME}"
  local name="${2:?usage: valheim-notify death-message INDEX NAME}"
  local -a DEATH_LINES=()
  load_death_lines
  render_death_message "$idx" "$name"
  echo "$DEATH_MSG"
}

usage() {
  echo "usage: valheim-notify {parse|watch|stopped|death-message INDEX NAME}" >&2
  exit 1
}

case "${1:-}" in
  parse) cmd_parse ;;
  watch) cmd_watch ;;
  stopped) cmd_stopped ;;
  death-message)
    shift
    cmd_death_message "$@"
    ;;
  *) usage ;;
esac
