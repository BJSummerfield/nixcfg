# Agent launchers for the devbox container.
# Paseo spawns agents as child processes, not login shells, so direnv never fires.
# Use `direnv exec .` to load the project devShell before running the agent.
# Fails open if .envrc is blocked (untrusted); warns on flake eval errors.
{ pkgs, lib }:
{
  mkAgent = { name, real }:
    pkgs.writeShellScriptBin name ''
      err=$(${lib.getExe pkgs.direnv} exec . true 2>&1 >/dev/null); rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "WARNING: .envrc found but not allowed (blocked/untrusted) for this directory or its parents:" >&2
        printf '%s\n' "$err" >&2
        echo "WARNING: running without a project devShell - toolchain binaries such as cargo will be missing." >&2
        exec ${real} "$@"
      fi
      if printf '%s' "$err" | grep -q '^error:'; then
        echo "WARNING: the project devShell may have failed to build:" >&2
        printf '%s\n' "$err" >&2
      fi
      exec ${lib.getExe pkgs.direnv} exec . ${real} "$@"
    '';
}