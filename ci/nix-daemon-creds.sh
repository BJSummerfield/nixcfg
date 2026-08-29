#!/usr/bin/env bash
# The private-source fetch and S3 cache read happen inside nix-daemon, not in
# the shell that invokes nix, so the credentials must reach the daemon's
# environment — a plain export would not. AWS_ACCESS_KEY_ID is optional for
# callers that only fetch private sources and never substitute.
set -euo pipefail

: "${PRIVATE_SRC_PAT:?the private-source PAT is required}"

conf=/etc/systemd/system/nix-daemon.service.d/credentials.conf
sudo mkdir -p "$(dirname "$conf")"

{
  echo '[Service]'
  echo 'Environment="NIX_GITHUB_PRIVATE_USERNAME=x-access-token"'
  echo "Environment=\"NIX_GITHUB_PRIVATE_PASSWORD=${PRIVATE_SRC_PAT}\""
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    : "${AWS_SECRET_ACCESS_KEY:?an access key id without its secret cannot authenticate}"
    echo "Environment=\"AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}\""
    echo "Environment=\"AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}\""
  fi
} | sudo tee "$conf" >/dev/null

# The file holds a PAT in cleartext; the default 0644 for drop-ins would put
# it in reach of anything else running on the runner.
sudo chmod 600 "$conf"

sudo systemctl daemon-reload
sudo systemctl restart nix-daemon
