#!/usr/bin/env bash
set -euo pipefail

dry_run=false
watch_file=""
for arg in "$@"; do
  case "$arg" in
  --dry-run) dry_run=true ;;
  *) watch_file="$arg" ;;
  esac
done

repo_root=$(git rev-parse --show-toplevel)
if [ -z "$watch_file" ]; then
  watch_file="$repo_root/ci/upstream-watch.json"
fi
pinned_rev=$(jq -r .nodes.nixpkgs.locked.rev "$repo_root/flake.lock")

entries=$(jq -c '.[]' "$watch_file")
if [ -n "$entries" ]; then
  while IFS= read -r entry; do
    repo=$(jq -r .repo <<<"$entry")
    pr=$(jq -r .pr <<<"$entry")
    branch=$(jq -r .branch <<<"$entry")
    title=$(jq -r .title <<<"$entry")
    pr_url="https://github.com/$repo/pull/$pr"

    merged=$(gh api "repos/$repo/pulls/$pr" --jq .merged)
    if [ "$merged" != "true" ]; then
      echo "$repo#$pr: not merged; nothing to do"
      continue
    fi

    merge_sha=$(gh api "repos/$repo/pulls/$pr" --jq .merge_commit_sha)
    branch_status=$(gh api "repos/$repo/compare/$branch...$merge_sha" --jq .status)
    if [ "$branch_status" != "behind" ] && [ "$branch_status" != "identical" ]; then
      echo "$repo#$pr: merged, but $branch does not contain the merge commit (status: $branch_status); nothing to do"
      continue
    fi

    pinned_status=$(gh api "repos/$repo/compare/$pinned_rev...$merge_sha" --jq .status)
    if [ "$pinned_status" = "behind" ] || [ "$pinned_status" = "identical" ]; then
      pinned_note="Our pinned nixpkgs rev $pinned_rev already contains the change."
    else
      pinned_note="Our pinned nixpkgs rev $pinned_rev does not yet contain the change."
    fi

    existing_titles=$(gh issue list --state all --search "\"$title\" in:title" --json title | jq -r '.[].title')
    if grep -Fxq -- "$title" <<<"$existing_titles"; then
      echo "$repo#$pr: an issue with the title \"$title\" already exists; nothing to do"
      continue
    fi

    body="The change from $pr_url is now in $branch.

$pinned_note"

    if [ "$dry_run" = true ]; then
      echo "would create issue:"
      echo "  title: $title"
      echo "  body:"
      printf '%s\n' "$body" | sed 's/^/    /'
    else
      gh issue create --title "$title" --body "$body"
    fi
  done <<<"$entries"
fi
