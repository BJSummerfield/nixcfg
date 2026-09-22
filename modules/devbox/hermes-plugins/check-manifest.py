"""Fail the build when a plugin manifest would be silently ignored at runtime.

A `name` that differs from the Nix attribute is installed and then skipped with
"not in plugins.enabled"; a `kind` other than `standalone` is routed to its own
discovery and never activated by `plugins.enabled` at all.

Usage: check-manifest.py <plugin.yaml> <expected-name>
"""

import sys

import yaml

manifest_path, expected = sys.argv[1], sys.argv[2]

with open(manifest_path, encoding="utf-8") as handle:
    data = yaml.safe_load(handle) or {}

errors = []

name = data.get("name")
if name != expected:
    errors.append(f"plugin.yaml name is {name!r}, but the Nix attribute is {expected!r}; "
                  "they must match or plugins.enabled will never gate this plugin")

kind = (data.get("kind") or "standalone").strip().lower()
if kind != "standalone":
    errors.append(f"plugin.yaml kind is {kind!r}; only 'standalone' plugins are activated "
                  "through plugins.enabled")

if errors:
    for error in errors:
        print(f"hermes plugin {expected}: {error}", file=sys.stderr)
    sys.exit(1)

print(f"hermes plugin {expected}: manifest ok (kind={kind})")
