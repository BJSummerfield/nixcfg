# Posts a one-line message to a Keybase chat via webhookbot.
#
# Usage: keybase-notify MESSAGE...
#   Arguments are joined with spaces to form the message.
#
# Config comes from two shell variables baked in by package.nix
# (DEFAULT_URL_FILE, DEFAULT_PREFIX, DEFAULT_TIME_ZONE), overridable at
# runtime by:
#   KEYBASE_NOTIFY_URL_FILE  path to a file containing just the webhook URL
#   KEYBASE_NOTIFY_PREFIX    text prepended to every message
#   KEYBASE_NOTIFY_TIME_ZONE zone of the time stamp appended to every post,
#                            e.g. America/Chicago; set but empty disables it
#   KEYBASE_NOTIFY_DRY_RUN=1 print the JSON body instead of posting
#
# The message is always logged first, before the JSON body is built, so a
# jq failure can't lose it silently. With no URL file configured, or an
# empty one, the log says "no webhook configured"; a URL file that exists
# but can't be read says "webhook url file unreadable" instead. Either way
# the message is only logged, not posted. The webhook URL itself never
# appears in argv, the environment of a child process, or the log: it is
# read straight from the file into a shell variable and handed to curl only
# through --config.
#
# This always exits 0: a broken or unreachable webhook must never fail the
# caller (systemd unit, updater, backup script, ...).
trap 'exit 0' EXIT

: "${DEFAULT_URL_FILE:=}"
: "${DEFAULT_PREFIX:=}"
: "${DEFAULT_TIME_ZONE:=}"

url_file="${KEYBASE_NOTIFY_URL_FILE:-$DEFAULT_URL_FILE}"
prefix="${KEYBASE_NOTIFY_PREFIX:-$DEFAULT_PREFIX}"
time_zone="${KEYBASE_NOTIFY_TIME_ZONE-$DEFAULT_TIME_ZONE}"

log() {
  echo "keybase-notify: $*" >&2
}

msg="$*"
log "$prefix$msg"

# Posting time, e.g. "3:42 PM CDT". Keybase shows its own time on hover, but
# in each reader's zone; this gives everyone the same one. date doesn't fail
# on an unknown zone, it prints UTC under the zone's name, so a zone with no
# zoneinfo file drops the stamp instead of posting a wrong time.
stamp=""
if [[ -n "$time_zone" && -f "${TZDIR:-/usr/share/zoneinfo}/$time_zone" ]]; then
  stamp=$(TZ="$time_zone" date '+%-I:%M %p %Z') || stamp=""
fi
body="$(jq -n --arg msg "$prefix$msg${stamp:+ · $stamp}" '{msg: $msg}')"

if [[ "${KEYBASE_NOTIFY_DRY_RUN:-}" == "1" ]]; then
  echo "$body"
  exit 0
fi

if [[ -z "$url_file" ]]; then
  log "not posted (no webhook configured)"
  exit 0
fi

if [[ ! -r "$url_file" ]]; then
  log "not posted (webhook url file unreadable)"
  exit 0
fi

url=""
read -r url <"$url_file" || true
url=${url%$'\r'}

if [[ -z "$url" ]]; then
  log "not posted (no webhook configured)"
  exit 0
fi

if ! echo "$body" | curl --silent --show-error --fail --connect-timeout 5 --max-time 10 --retry 1 \
  -H 'Content-Type: application/json' --data-binary @- -o /dev/null \
  --config <(printf 'url = "%s"\n' "$url"); then
  log "post failed (ignored)"
fi

exit 0
