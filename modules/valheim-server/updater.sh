# Valheim build updater.
#
# Config comes only from the env contract (set by the systemd units in
# nixos.nix): VALHEIM_INSTALL, VALHEIM_APP_ID, VALHEIM_BRANCH,
# VALHEIM_FORCE_AFTER_MIN, VALHEIM_USER, VALHEIM_CHECK_TIMEOUT_MIN,
# VALHEIM_STAGE_TIMEOUT_MIN, VALHEIM_LOCK_WAIT_MIN. No Nix interpolation.
#
# Layout under VALHEIM_INSTALL (one filesystem, so renames are atomic):
#   current          relative symlink to slots/a or slots/b
#   slots/a slots/b  each a full DepotDownloader -dir, own .DepotDownloader/
#   state/check      manifest-only scratch dir for `check`
#   state/home       HOME for DepotDownloader
#   state/log        stage logs
#   state/remote     last build `check` saw: "branch NAME" then "depot manifest" lines
#   state/pending    slot name of a staged build waiting to go live; mtime = staged-at
#   state/swap-in-progress  flag so ExecStopPost restarts the server after a killed swap
#   state/lock       flock held by `auto` and `now` so they never race each other
#
# Each slot's own installed build is recorded in slots/X/.valheim-manifests,
# written in the same "branch\ndepot manifest..." format as state/remote, but
# only after a download is fully verified. Comparisons ignore the branch line
# so switching branch onto an already-downloaded build is a no-op; branch is
# only used to pick what to pass DepotDownloader.
#
# A manual `valheim-updater now` racing an `auto` tick waits for the lock
# rather than failing.
#
# VALHEIM_NOTIFY, when non-empty, is the path to a keybase-notify binary
# (already baked with its own URL file and prefix). It is always run through
# the notify() helper, which never lets a hung or failing post delay the
# updater beyond 25s: `timeout 25 ... 9>&-` so the child never inherits the
# lock fd, and a failure is logged and ignored. An empty value means off.

: "${VALHEIM_INSTALL:?VALHEIM_INSTALL must be set}"
: "${VALHEIM_APP_ID:?VALHEIM_APP_ID must be set}"
: "${VALHEIM_BRANCH?VALHEIM_BRANCH must be set (empty string for public)}"
: "${VALHEIM_FORCE_AFTER_MIN:?VALHEIM_FORCE_AFTER_MIN must be set}"
: "${VALHEIM_USER:?VALHEIM_USER must be set}"
: "${VALHEIM_CHECK_TIMEOUT_MIN:?VALHEIM_CHECK_TIMEOUT_MIN must be set}"
: "${VALHEIM_STAGE_TIMEOUT_MIN:?VALHEIM_STAGE_TIMEOUT_MIN must be set}"
: "${VALHEIM_LOCK_WAIT_MIN:?VALHEIM_LOCK_WAIT_MIN must be set}"
: "${VALHEIM_NOTIFY?VALHEIM_NOTIFY must be set (empty string for none)}"

INSTALL="$VALHEIM_INSTALL"
SLOTS="$INSTALL/slots"
STATE="$INSTALL/state"
CHECK_DIR="$STATE/check"
HOME_DIR="$STATE/home"
LOG_DIR="$STATE/log"
REMOTE_FILE="$STATE/remote"
PENDING_FILE="$STATE/pending"
LOCK_FILE="$STATE/lock"
CURRENT_LINK="$INSTALL/current"

log() {
  echo "valheim-updater: $*"
}

notify() { [[ -n "$VALHEIM_NOTIFY" ]] || return 0; timeout 25 "$VALHEIM_NOTIFY" "$*" 9>&- || log "notify: post failed (ignored)"; }

# Every directory the valheim user writes into is created (or re-chowned)
# with this helper so a pre-existing install self-heals if ownership ever
# drifted (e.g. a manual `chown -R root` mistake).
ensure_dir() {
  install -d -o "$VALHEIM_USER" -g "$VALHEIM_USER" -m 0700 "$1"
}

run_as_valheim() {
  setpriv --reuid="$VALHEIM_USER" --regid="$VALHEIM_USER" --init-groups "$@"
}

# Writes stdin to $1, owned by the valheim user, via tmp+rename so a reader
# never sees a partial file.
# Callers run inside `if !`, where set -e is off, so every step is checked
# by hand: a disk-full cat must not leave a truncated file in place.
write_owned() {
  local dest="$1" tmp
  tmp=$(mktemp "${dest}.XXXXXX") || return 1
  if ! { cat >"$tmp" && chown "$VALHEIM_USER:$VALHEIM_USER" "$tmp" && mv -f "$tmp" "$dest"; }; then
    rm -f "$tmp"
    return 1
  fi
}

active_slot() {
  basename "$(readlink "$CURRENT_LINK")"
}

inactive_slot() {
  if [[ "$(active_slot)" == a ]]; then
    echo b
  else
    echo a
  fi
}

# Depot/manifest lines only (branch line dropped), sorted, for equality
# checks. A branch switch onto identical manifests is then a no-op.
remote_compare_lines() {
  tail -n +2 "$REMOTE_FILE" | sort
}

marker_compare_lines() {
  local marker="$SLOTS/$1/.valheim-manifests"
  if [[ -f "$marker" ]]; then
    tail -n +2 "$marker" | sort
  fi
}

cmd_layout() {
  ensure_dir "$STATE"
  rm -f "$STATE/swap-in-progress"
  rm -f "$STATE/stop-reason"

  if [[ ! -e "$CURRENT_LINK" ]] \
    && { [[ -e "$INSTALL/valheim_server.x86_64" ]] || [[ -e "$INSTALL/.DepotDownloader" ]]; }; then
    log "layout: migrating flat install into slots/a"
    ensure_dir "$SLOTS/a"
    # Move everything except slots/, state/, current into slots/a. find lists
    # dotfiles too (unlike a shell glob), which is what picks up
    # .DepotDownloader here.
    find "$INSTALL" -mindepth 1 -maxdepth 1 \
      -not \( -name slots -o -name state -o -name current \) \
      -exec mv -t "$SLOTS/a" {} +
    ln -sfn slots/a "$CURRENT_LINK"
    # Seed slots/b from slots/a so the first stage into b is a delta instead
    # of a full re-download. No marker in either slot: the migrated build's
    # exact manifest set isn't known, so the next check+stage does one
    # unavoidable full-ish re-download to establish one.
    ensure_dir "$SLOTS/b"
    run_as_valheim cp -a --reflink=auto "$SLOTS/a/." "$SLOTS/b/"
  elif [[ ! -e "$CURRENT_LINK" ]]; then
    log "layout: no existing install, creating empty slots"
    ensure_dir "$SLOTS/a"
    ensure_dir "$SLOTS/b"
    ln -sfn slots/a "$CURRENT_LINK"
  else
    ensure_dir "$SLOTS/a"
    ensure_dir "$SLOTS/b"
  fi

  ensure_dir "$CHECK_DIR"
  ensure_dir "$HOME_DIR"
  ensure_dir "$LOG_DIR"

  # Self-heal ownership of the slot directories themselves every run.
  chown "$VALHEIM_USER:$VALHEIM_USER" "$SLOTS"/* 2>/dev/null || true

  # Apply a build that finished staging but never got swapped in (updater
  # killed, container/host restarted, etc). Applying here rather than
  # waiting for the next auto tick means a container restart picks up a
  # ready build immediately.
  if [[ -s "$PENDING_FILE" ]]; then
    local slot
    slot=$(<"$PENDING_FILE")
    if [[ -f "$SLOTS/$slot/.valheim-manifests" && -f "$SLOTS/$slot/valheim_server.x86_64" ]]; then
      log "layout: applying build staged in slot $slot"
      ln -sfn "slots/$slot" "$CURRENT_LINK"
    fi
    rm -f "$PENDING_FILE"
  fi
}

cmd_check() {
  ensure_dir "$CHECK_DIR"
  rm -f "$CHECK_DIR"/manifest_*.txt

  local branch_args=()
  if [[ -n "$VALHEIM_BRANCH" ]]; then
    branch_args=(-branch "$VALHEIM_BRANCH")
  fi

  local log_file="$CHECK_DIR/check.log"
  # timeout has to run inside the setpriv-dropped process, not wrap it:
  # setpriv is a real binary timeout can exec, but the run_as_valheim shell
  # function it lives in is not, so timeout has to be one of its arguments.
  if ! run_as_valheim timeout "${VALHEIM_CHECK_TIMEOUT_MIN}m" \
    env HOME="$HOME_DIR" DepotDownloader \
    -app "$VALHEIM_APP_ID" -osarch 64 "${branch_args[@]}" \
    -dir "$CHECK_DIR" -manifest-only \
    >"$log_file" 2>&1; then
    log "check: DepotDownloader failed or timed out"
    cat "$log_file" >&2
    return 1
  fi

  # DepotDownloader exits 0 even when a depot it couldn't fetch info for was
  # silently skipped, so these known Steam-side errors are checked for by
  # hand even though the exit code looked fine.
  if grep -qE \
    'is not available from this account|missing public subsection or manifest section|No valid depot key|Unable to create install directories' \
    "$log_file"; then
    log "check: DepotDownloader reported a depot error"
    cat "$log_file" >&2
    return 1
  fi

  local resolved_branch="$VALHEIM_BRANCH"
  if grep -q 'does not have branch named' "$log_file"; then
    log "check: branch '$VALHEIM_BRANCH' not found, falling back to public"
    resolved_branch=""
  fi

  # Depot processing order, taken from "Processing depot N" lines rather
  # than sorting the manifest_* filenames, so stage can pass -depot/-manifest
  # pairs in the same order DepotDownloader itself used.
  local depots_in_order
  depots_in_order=$(grep -oE 'Processing depot [0-9]+' "$log_file" | awk '{print $3}')
  if [[ -z "$depots_in_order" ]]; then
    log "check: no depots processed"
    return 1
  fi

  local remote_content="branch ${resolved_branch:-public}"$'\n'
  local depot manifest_file manifest_id
  while IFS= read -r depot; do
    manifest_file=$(find "$CHECK_DIR" -maxdepth 1 -name "manifest_${depot}_*.txt" -print -quit)
    if [[ -z "$manifest_file" ]]; then
      log "check: missing manifest file for depot $depot"
      return 1
    fi
    manifest_id=$(basename "$manifest_file")
    manifest_id=${manifest_id#manifest_"${depot}"_}
    manifest_id=${manifest_id%.txt}
    remote_content+="$depot $manifest_id"$'\n'
  done <<<"$depots_in_order"

  # printf, not <<<: a here-string would add a blank last line, which stage
  # would read as an empty -depot/-manifest pair.
  if ! printf '%s' "$remote_content" | write_owned "$REMOTE_FILE"; then
    log "check: could not write $REMOTE_FILE"
    return 1
  fi

  # Loud, non-gating warning: a depot set change usually means the app's
  # depot list itself changed upstream, worth a human glancing at it.
  local remote_depots active_depots
  remote_depots=$(tail -n +2 "$REMOTE_FILE" | awk '{print $1}' | sort -u)
  active_depots=$(marker_compare_lines "$(active_slot)" | awk '{print $1}' | sort -u)
  if [[ -n "$active_depots" && "$remote_depots" != "$active_depots" ]]; then
    log "WARNING: check: remote depot set differs from the active build's depot set"
  fi

  # Cached manifests from old checks accumulate forever otherwise.
  if [[ -d "$CHECK_DIR/.DepotDownloader" ]]; then
    find "$CHECK_DIR/.DepotDownloader" -maxdepth 1 -name '*.manifest*' -mtime +30 -delete
  fi
}

cmd_stage() {
  local slot="$1" force=0
  if [[ "${2:-}" == "--force" ]]; then
    force=1
  fi
  case "$slot" in
    a | b) ;;
    *)
      log "stage: invalid slot '$slot'"
      return 1
      ;;
  esac

  if [[ ! -s "$REMOTE_FILE" ]]; then
    log "stage: no state/remote yet, run check first"
    return 1
  fi

  local marker="$SLOTS/$slot/.valheim-manifests"
  if [[ $force -eq 0 && -f "$marker" ]] \
    && [[ "$(remote_compare_lines)" == "$(marker_compare_lines "$slot")" ]]; then
    log "stage: slot $slot already matches the remote build"
    return 0
  fi

  # Deleted up front, not after: -manifest-only against a real install marks
  # the depot's manifest invalid in .DepotDownloader/depot.config and never
  # restores it on that code path, so a half-finished stage must never look
  # complete, and a stale marker must never survive a failed re-stage.
  rm -f "$marker"
  ensure_dir "$SLOTS/$slot"
  ensure_dir "$LOG_DIR"

  local resolved_branch
  resolved_branch=$(head -1 "$REMOTE_FILE" | awk '{print $2}')
  local branch_args=()
  if [[ "$resolved_branch" != "public" ]]; then
    branch_args=(-branch "$resolved_branch")
  fi

  # Pinned in the order check recorded them, not sorted.
  local depot_args=() depot manifest_id
  while read -r depot manifest_id; do
    depot_args+=(-depot "$depot" -manifest "$manifest_id")
  done < <(tail -n +2 "$REMOTE_FILE")

  local log_file="$LOG_DIR/stage-$slot.log"
  if ! run_as_valheim timeout "${VALHEIM_STAGE_TIMEOUT_MIN}m" \
    env HOME="$HOME_DIR" DepotDownloader \
    -app "$VALHEIM_APP_ID" -osarch 64 "${branch_args[@]}" \
    -dir "$SLOTS/$slot" -validate "${depot_args[@]}" \
    2>&1 | tee "$log_file"; then
    log "stage: DepotDownloader failed or timed out for slot $slot"
    return 1
  fi

  # As in check: exit 0 doesn't mean every pinned depot actually downloaded.
  while read -r depot manifest_id; do
    if ! grep -q "Depot $depot - Downloaded" "$log_file"; then
      log "stage: depot $depot missing from the download log"
      return 1
    fi
  done < <(tail -n +2 "$REMOTE_FILE")

  local exe="$SLOTS/$slot/valheim_server.x86_64"
  if [[ ! -e "$exe" ]]; then
    log "stage: $exe missing after download"
    return 1
  fi
  chmod +x "$exe"

  write_owned "$marker" <"$REMOTE_FILE"
}

# Reads journal lines already filtered to "Got connection SteamID",
# "Closing socket" and "Connections N ZDOS" from stdin and prints the
# current player count, or "unknown" (exit 2) if no Connections line was
# ever seen (nothing to compare the connect/disconnect tally against).
cmd_players() {
  local -A connected=()
  local last_conn="" line

  while IFS= read -r line; do
    if [[ "$line" =~ Got\ connection\ SteamID\ ([0-9]+) ]]; then
      connected["${BASH_REMATCH[1]}"]=1
    elif [[ "$line" =~ Closing\ socket\ ([0-9]+) ]]; then
      unset "connected[${BASH_REMATCH[1]}]"
    elif [[ "$line" =~ Connections\ ([0-9]+)\ ZDOS: ]]; then
      last_conn="${BASH_REMATCH[1]}"
    fi
  done

  if [[ -z "$last_conn" ]]; then
    echo unknown
    return 2
  fi

  # A missed disconnect log leaves the tally stuck above the real count;
  # take whichever signal says more players are present.
  local tally=${#connected[@]} count=$last_conn
  if ((tally > count)); then
    count=$tally
  fi
  echo "$count"
}

# Exit 0 only when the server is provably empty; any doubt (not running
# reads as empty since there's nothing to disturb, but unparseable/missing
# logs while it IS running) reads as busy so a bad log never forces a swap.
cmd_idle() {
  if ! systemctl is-active --quiet valheim.service; then
    return 0
  fi

  local invocation_id
  invocation_id=$(systemctl show -p InvocationID --value valheim.service)
  if [[ -z "$invocation_id" || "$invocation_id" =~ ^0*$ ]]; then
    return 1
  fi

  local count
  if ! count=$(
    journalctl _SYSTEMD_INVOCATION_ID="$invocation_id" -o cat \
      -g 'Got connection SteamID|Closing socket|Connections [0-9]+ ZDOS' \
      | cmd_players
  ); then
    return 1
  fi
  [[ "$count" == 0 ]]
}

# forced=1 means the swap is happening at the forceRestartAfter deadline with
# players still connected, rather than because the server went idle: the
# "going down" post is skipped in favor of a "forcing" one, sent by the
# caller (cmd_auto) before this runs. Both cases still mark the stop as a
# self-inflicted update so the ExecStopPost hook stays silent about it.
cmd_swap() {
  local slot="$1" forced="${2:-0}"
  case "$slot" in
    a | b) ;;
    *)
      log "swap: invalid slot '$slot'"
      return 1
      ;;
  esac

  if systemctl is-active --quiet valheim.service; then
    write_owned "$STATE/stop-reason" <<<"update" || log "swap: could not record stop-reason"
    if ((forced)); then
      notify "🔄 Update wait is over: restarting Valheim now for the update"
    else
      notify "🔄 Valheim going down for an update, back in a couple of minutes"
    fi
  fi

  touch "$STATE/swap-in-progress"
  systemctl stop valheim.service
  ln -sfn "slots/$slot" "$INSTALL/.current.tmp"
  mv -Tf "$INSTALL/.current.tmp" "$CURRENT_LINK"
  rm -f "$PENDING_FILE"
  systemctl start valheim.service
  rm -f "$STATE/stop-reason"
  rm -f "$STATE/swap-in-progress"
}

cmd_auto() {
  ensure_dir "$STATE"
  exec 9>"$LOCK_FILE"
  chown "$VALHEIM_USER:$VALHEIM_USER" "$LOCK_FILE" 2>/dev/null || true
  if ! flock -n 9; then
    log "auto: a manual run holds the lock, skipping this tick"
    return 0
  fi

  if ! cmd_check; then
    log "auto: check failed, will retry next tick"
    return 0
  fi

  local active
  active=$(active_slot)
  if [[ "$(remote_compare_lines)" == "$(marker_compare_lines "$active")" ]]; then
    rm -f "$PENDING_FILE"
    return 0
  fi

  local target
  target=$(inactive_slot)
  if ! cmd_stage "$target"; then
    log "auto: stage of slot $target failed"
    return 1
  fi

  # Keep an existing pending file's mtime: that's the staged-at time the
  # force deadline below is measured from, and must survive a killed and
  # re-run updater landing on the same already-staged target.
  local fresh=0
  if [[ ! -s "$PENDING_FILE" ]]; then
    write_owned "$PENDING_FILE" <<<"$target"
    fresh=1
  fi

  local deadline
  deadline=$(($(stat -c %Y "$PENDING_FILE") + VALHEIM_FORCE_AFTER_MIN * 60))

  local last_state="" last_log_ts=0 waiting_notified=0 warned_5min=0
  while true; do
    local now state reason
    now=$(date +%s)
    if cmd_idle; then
      state=idle
      reason="server is empty"
    elif ((now >= deadline)); then
      state=forced
      reason="forceRestartAfter deadline reached"
    else
      state=busy
      reason="players connected, or player count unknown"
    fi

    # Log on every state change, and otherwise at most once per ~10 minutes
    # so a long wait doesn't spam the journal.
    if [[ "$state" != "$last_state" ]] || ((now - last_log_ts >= 600)); then
      log "auto: $state ($reason)"
      last_state="$state"
      last_log_ts=$now
    fi

    if [[ "$state" == busy ]]; then
      if ((fresh == 1 && waiting_notified == 0)); then
        notify "⬇️ A Valheim update is downloaded. The server restarts onto it once the server is empty, or in $VALHEIM_FORCE_AFTER_MIN min regardless. Players who have already updated can't join until then."
        waiting_notified=1
      fi
      if ((warned_5min == 0 && VALHEIM_FORCE_AFTER_MIN > 5 && deadline - now <= 300)); then
        notify "⏳ Valheim restarts for the update in about *5 minutes*, whether or not anyone is online"
        warned_5min=1
      fi
    fi

    if [[ "$state" != busy ]]; then
      break
    fi
    sleep 30
  done

  if [[ "$state" == forced ]]; then
    cmd_swap "$target" 1
  else
    cmd_swap "$target"
  fi
}

cmd_now() {
  ensure_dir "$STATE"
  exec 9>"$LOCK_FILE"
  chown "$VALHEIM_USER:$VALHEIM_USER" "$LOCK_FILE" 2>/dev/null || true
  if ! flock -w "$((VALHEIM_LOCK_WAIT_MIN * 60))" 9; then
    log "now: timed out waiting for the lock"
    return 1
  fi

  if ! cmd_check; then
    log "now: check failed, server untouched"
    return 1
  fi

  local target
  target=$(inactive_slot)
  if ! cmd_stage "$target" --force; then
    log "now: stage of slot $target failed"
    return 1
  fi

  rm -f "$PENDING_FILE"
  cmd_swap "$target"
}

cmd_stop_post() {
  # The flag belongs to whoever holds the lock. An auto tick that skipped
  # because `now` is mid-swap must not start the server under it.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    return 0
  fi
  if [[ -e "$STATE/swap-in-progress" ]]; then
    rm -f "$STATE/swap-in-progress"
    systemctl start --no-block valheim.service || true
  fi
}

usage() {
  echo "usage: valheim-updater {layout|check|stage SLOT [--force]|players|idle|swap SLOT|auto|now|stop-post}" >&2
  exit 1
}

case "${1:-}" in
  layout) cmd_layout ;;
  check) cmd_check ;;
  stage)
    shift
    [[ $# -ge 1 ]] || usage
    cmd_stage "$@"
    ;;
  players) cmd_players ;;
  idle) cmd_idle ;;
  swap)
    shift
    [[ $# -eq 1 ]] || usage
    cmd_swap "$@"
    ;;
  auto) cmd_auto ;;
  now) cmd_now ;;
  stop-post) cmd_stop_post ;;
  *) usage ;;
esac
