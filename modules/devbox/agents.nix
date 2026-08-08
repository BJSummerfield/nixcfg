# Agent launchers for the devbox container.
#
# Paseo spawns agents as child processes of its daemon, not as login
# shells, so direnv's shell hook never fires and the project's devShell is
# never entered. Without this wrapper the agent lands in a bare environment
# and toolchain binaries that come from the flake - cargo, node, whatever -
# are simply absent. That is the bug the ephemeral coding-agents pool had;
# it is not fixed by enabling direnv, only by loading the .envrc explicitly.
#
# `direnv exec DIR CMD` is the non-interactive form. It searches DIR *and
# its parents* for a `.envrc`, so it is used as the source of truth for
# whether one applies here - not a `[ -f .envrc ]` guard in this script,
# which only ever checked the cwd and so missed every subdirectory launch
# (e.g. a task scoped to `repo/crates/foo`), silently skipping the
# devShell with no warning at all.
#
# direnv's allow-list is whitelisted by prefix for both trees agents run
# in (see modules/devbox/container.nix's programs.direnv.config.whitelist),
# so "not allowed" is no longer an expected outcome here - but
# `direnv exec` is still what decides whether a `.envrc` applies at all.
# Measured behaviour of `direnv exec . true`:
#   - no .envrc anywhere up the tree: exits 0, empty stderr, environment
#     passed through unmodified (there is nothing to load, so nothing to
#     warn about - this runs silently and that's correct)
#   - a .envrc exists but is *blocked* (untrusted): exits non-zero, with
#     "direnv: error ... is blocked" on stderr
#   - an allowed .envrc whose flake fails to evaluate: exits 0, with
#     `error:` on stderr (see the nix-direnv fail-open note below)
# So `rc != 0` below fires only for the second case: an .envrc exists
# outside the whitelisted prefixes above and was never allowed. Given the
# whitelist that should be rare in practice, but it's the one case worth
# failing open loudly for, since it means something is running outside the
# trees this container expects agents to work in.
#
# Why the `^error:` check is diagnostic-only, not another fail-open branch.
# nix-direnv fails *open*: a flake that will not evaluate still produces a
# successful `direnv exec`, because refusing to load would lock you out of
# the directory. So a false-positive `^error:` match must never cost the
# agent its devShell - `direnv exec` running through a broken-but-allowed
# .envrc is never worse than running bare, so the direnv path stays the
# default and the error match only adds a warning on top of it.
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
