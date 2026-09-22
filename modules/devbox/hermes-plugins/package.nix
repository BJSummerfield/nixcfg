# Package a directory-based Hermes plugin for
# `services.hermes-agent.extraPlugins`.
#
# Upstream's activation symlinks each entry as
# `$HERMES_HOME/plugins/nix-managed-<lib.getName drv>`, so the derivation name
# is what ends up on disk, and the module asserts those names are unique.
{
  lib,
  runCommand,
  python3,
}:
{
  # The plugin's manifest `name`. Also the key `plugins.enabled` is matched
  # against, which is why check-manifest.py refuses a mismatch.
  name,
  # Directory holding plugin.yaml and __init__.py.
  src,
  # Toolset names this plugin registers via `toolsets.create_custom_toolset`.
  # Nothing in the manifest declares these - there is no `provides_toolsets`
  # field - so they are stated here and carried on passthru, which is what
  # lets hermes-plugins.nix catch a profile referencing `readonly` while the
  # plugin that defines it is switched off.
  providesToolsets ? [ ],
}:
runCommand name
  {
    inherit src;
    nativeBuildInputs = [ (python3.withPackages (ps: [ ps.pyyaml ])) ];
    passthru = { inherit providesToolsets; };
    meta.description = "Hermes agent plugin ${name}";
  }
  ''
    for required in plugin.yaml __init__.py; do
      if [ ! -f "$src/$required" ]; then
        echo "hermes plugin ${name}: $src has no $required" >&2
        exit 1
      fi
    done

    python3 ${./check-manifest.py} "$src/plugin.yaml" ${lib.escapeShellArg name}

    # Byte-compile as a syntax check. A plugin whose __init__.py does not parse
    # is caught by the build rather than by a warning in the agent's log.
    # PYTHONPYCACHEPREFIX keeps the .pyc out of both $src (read-only store) and
    # $out (Hermes imports the source; a stale cache dir would just be noise).
    PYTHONPYCACHEPREFIX="$TMPDIR/pycache" python3 -m py_compile "$src/__init__.py"

    cp -r "$src" $out
    chmod -R u+w $out
  ''
