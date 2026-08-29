# Paseo spawns agents as child processes, not login shells, so direnv
# never fires; the launcher wraps the agent in `direnv exec .` to load the
# project devShell. Fails open if .envrc is blocked (untrusted); warns on
# flake eval errors.
{ pkgs, lib }:
{
  mkAgent =
    {
      name,
      real,
      # Extra flags appended to every invocation, before the caller's own.
      # Interpolated into both exec paths so an agent cannot lose them by
      # having an untrusted .envrc.
      args ? "",
    }:
    pkgs.writeShellScriptBin name ''
      err=$(${lib.getExe pkgs.direnv} exec . true 2>&1 >/dev/null); rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "WARNING: .envrc found but not allowed (blocked/untrusted) for this directory or its parents:" >&2
        printf '%s\n' "$err" >&2
        echo "WARNING: running without a project devShell - toolchain binaries such as cargo will be missing." >&2
        exec ${real} ${args} "$@"
      fi
      if printf '%s' "$err" | grep -q '^error:'; then
        echo "WARNING: the project devShell may have failed to build:" >&2
        printf '%s\n' "$err" >&2
      fi
      exec ${lib.getExe pkgs.direnv} exec . ${real} ${args} "$@"
    '';
}
