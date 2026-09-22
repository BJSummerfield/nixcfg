{
  lib,
  runCommand,
  python3,
}:
{
  # Must match plugin.yaml's `name`: that is the key `plugins.enabled` is matched against.
  name,
  src,
  providesToolsets ? [ ],
}:
runCommand name
  {
    inherit src;
    nativeBuildInputs = [ (python3.withPackages (ps: [ ps.pyyaml ])) ];
    passthru = {
      inherit providesToolsets;
      pluginSrc = src;
    };
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

    # Syntax check only; the prefix keeps the .pyc out of the read-only $src and out of $out.
    PYTHONPYCACHEPREFIX="$TMPDIR/pycache" python3 -m py_compile "$src/__init__.py"

    cp -r "$src" $out
    chmod -R u+w $out
  ''
