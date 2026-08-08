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
#
# Why two branches and not an exit-code check. nix-direnv fails *open*: a
# flake that will not evaluate still produces a successful `direnv exec`,
# because refusing to load would lock you out of the directory. An
# exit-status probe therefore detects "not allowed" and nothing else - with
# an allowed .envrc over a broken flake it returns 0, the agent runs in a
# bare environment, and no warning fires. That is precisely the invisible
# toolchain-missing failure this wrapper exists to prevent, so the probe
# must read stderr too, and must print the build error rather than discard
# it.
{ pkgs, lib }:
{
  mkAgent = { name, real }:
    pkgs.writeShellScriptBin name ''
      if [ -f .envrc ]; then
        err=$(${lib.getExe pkgs.direnv} exec . true 2>&1 >/dev/null); rc=$?
        if [ "$rc" -ne 0 ]; then
          echo "WARNING: .envrc is present but not allowed - fix with: direnv allow ${"\${PWD}"}" >&2
        elif printf '%s' "$err" | grep -q '^error:'; then
          echo "WARNING: the project devShell failed to build:" >&2
          printf '%s\n' "$err" >&2
        else
          exec ${lib.getExe pkgs.direnv} exec . ${real} "$@"
        fi
        echo "WARNING: running without the project devShell - toolchain binaries such as cargo will be missing." >&2
      fi
      exec ${real} "$@"
    '';
}
