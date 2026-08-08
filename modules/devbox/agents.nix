# Agent launchers for the devbox container.
#
# Paseo spawns agents as child processes of its daemon, not as login
# shells, so direnv's shell hook never fires and the project's devShell is
# never entered. Without this wrapper the agent lands in a bare environment
# and toolchain binaries that come from the flake - cargo, node, whatever -
# are simply absent. That is the bug the ephemeral coding-agents pool had;
# it is not fixed by enabling direnv, only by loading the .envrc explicitly.
#
# `direnv exec DIR CMD` is the non-interactive form. It refuses to run when
# the .envrc is untrusted, so we probe first and fall through with a loud
# warning rather than killing the session - a dead agent session is a worse
# failure than a slow one, especially when the client is a phone.
{ pkgs, lib }:
{
  mkAgent = { name, real }:
    pkgs.writeShellScriptBin name ''
      if [ -f .envrc ]; then
        if ${lib.getExe pkgs.direnv} exec . true >/dev/null 2>&1; then
          exec ${lib.getExe pkgs.direnv} exec . ${real} "$@"
        fi
        echo "WARNING: .envrc is present but direnv could not load it (not allowed, or the devShell failed to build)." >&2
        echo "WARNING: running without the project devShell - toolchain binaries such as cargo will be missing." >&2
        echo "WARNING: fix with: direnv allow ${"\${PWD}"}" >&2
      fi
      exec ${real} "$@"
    '';
}
