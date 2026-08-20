#!/usr/bin/env bash
# Prunes the Nix binary cache to the newest $CACHE_KEEP manifests.
#
# Retention is manifest-driven, never timestamp-driven: nix copy skips paths
# already present, so an object's LastModified does not track whether it is
# still in use, and any age-based rule would eventually delete a live NAR.
set -euo pipefail

BUCKET="${CACHE_BUCKET:?CACHE_BUCKET is required}"
ENDPOINT="${CACHE_ENDPOINT:?CACHE_ENDPOINT is required}"
KEEP="${CACHE_KEEP:-2}"

s3() { aws --endpoint-url "$ENDPOINT" "$@"; }
# grep exits 1 when it filters everything out, which under pipefail would abort
# the run before the empty-manifest guard below could report it.
keys() { tr '\t' '\n' | { grep -Ev '^(None)?$' || true; } | sort; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix manifests/ \
  --query 'Contents[].Key' --output text | keys > "$work/manifests-all"

tail -n "$KEEP" "$work/manifests-all" > "$work/manifests-keep"

# An empty manifest list would make every object unreferenced and delete the
# whole cache, so refuse rather than proceed.
if [ ! -s "$work/manifests-keep" ]; then
  echo "prune-cache: no manifests found in s3://$BUCKET/manifests/; refusing to prune" >&2
  exit 1
fi

: > "$work/paths-keep"
while read -r key; do
  s3 s3 cp "s3://$BUCKET/$key" - | jq -r '.[]' >> "$work/paths-keep"
done < "$work/manifests-keep"
sort -u "$work/paths-keep" -o "$work/paths-keep"

: > "$work/objects-keep"
while read -r path; do
  hash="${path#/nix/store/}"
  hash="${hash%%-*}"
  echo "$hash.narinfo" >> "$work/objects-keep"
  s3 s3 cp "s3://$BUCKET/$hash.narinfo" - 2>/dev/null \
    | awk '/^URL: /{print $2}' >> "$work/objects-keep" || true
done < "$work/paths-keep"

cat "$work/manifests-keep" >> "$work/objects-keep"
echo "nix-cache-info" >> "$work/objects-keep"
sort -u "$work/objects-keep" -o "$work/objects-keep"

s3 s3api list-objects-v2 --bucket "$BUCKET" \
  --query 'Contents[].Key' --output text | keys > "$work/objects-all"

comm -23 "$work/objects-all" "$work/objects-keep" > "$work/objects-delete"

echo "prune-cache: keeping $(wc -l < "$work/objects-keep"), deleting $(wc -l < "$work/objects-delete")"

while read -r key; do
  s3 s3 rm "s3://$BUCKET/$key"
done < "$work/objects-delete"
