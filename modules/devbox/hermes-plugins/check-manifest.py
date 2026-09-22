"""Build-time guard for a packaged Hermes plugin directory.

Two things can go wrong silently and only show up as a missing feature at
runtime, so both are build failures instead:

  * plugin.yaml's `name` differs from the Nix attribute name. That name is the
    key Hermes looks for in `plugins.enabled`, so a mismatch installs the
    plugin and then skips it with "not in plugins.enabled".
  * `kind` is not `standalone`. Other kinds (exclusive, model-provider,
    platform, backend) are routed to their own discovery and are NOT activated
    by `plugins.enabled`, so the Nix wiring would be a no-op.

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
