# Agent launchers for the devbox container.
# Paseo spawns agents as child processes, not login shells, so direnv never fires.
# Use `direnv exec .` to load the project devShell before running the agent.
# Fails open if .envrc is blocked (untrusted); warns on flake eval errors.
{ pkgs, lib }:
let
  mkAgent =
    {
      name,
      real,
      # Extra flags appended to every invocation, before the caller's own.
      # Interpolated into both exec paths below - the fail-open one and the
      # normal one - so an agent cannot lose them by having an untrusted
      # .envrc.
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

  # Seeded for pi as ~/.pi/agent/APPEND_SYSTEM.md by the home.file below, and
  # passed to claude on the command line in mkAgent.
  #
  # It does not reach every pi subagent. pi discovers the global file only when
  # no --append-system-prompt was passed (resource-loader.js: `if (!appendSources)`),
  # and pi-subagents spends that flag on the agent's own body whenever the agent
  # sets `systemPromptMode: append` - the bundled `delegate`, and any custom
  # agent written that way. Agents in `replace` mode (worker, reviewer,
  # researcher, scout, oracle) take --system-prompt instead, leave the append
  # slot free, and do get this file. Anything *all* children must see belongs in
  # pi-coding-agent/AGENTS.md, which reaches them through project context.
  envContract = ./ENVIRONMENT.md;

  # Pi needs bun and node on PATH or plugins crash at startup.
  # Wrapped here because the upstream module is disabled below.
  piWrapped = pkgs.symlinkJoin {
    name = "pi-wrapped";
    paths = [ pkgs.pi-coding-agent ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi --suffix PATH : ${lib.makeBinPath (import ../pi-coding-agent/extra-packages.nix pkgs)}
    '';
  };

  agentPkgs = [
    (mkAgent {
      name = "claude";
      real = lib.getExe pkgs.claude-code;
      # Claude has no equivalent of pi's environment-contract file below, and
      # the appendSystemPromptFile settings key is inert on 2.1.234 - the CLI
      # flag is the only mechanism that works.
      args = ''--append-system-prompt "$(cat ${envContract})"'';
    })
    (mkAgent {
      name = "pi";
      # piWrapped is a symlinkJoin (name "pi-wrapped") with no meta.mainProgram,
      # so a naive lib.getExe would resolve to the wrong binary name.
      real = lib.getExe' piWrapped "pi";
    })
  ];

  # Wrapped to inject GH_TOKEN at use time so it never lands in the nix store.
  # Replaces bare pkgs.gh — pkgs.buildEnv fails on duplicate names.
  ghWrapped = pkgs.writeShellScriptBin "gh" ''
    export GH_TOKEN=$(cat /run/secrets/github-token)
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  # Claude keeps preferences in one small file. No enabledPlugins entry:
  # claude runs no plugins here. A rebuild re-seeds this file only; auth
  # lives separately in .credentials.json and is untouched.
  #
  # Dropping the entry only stops nix *enabling* a plugin - it does not
  # uninstall one. A container that ran the superpowers plugin still has
  # claude's own state for it (marketplace clone, plugin cache,
  # installed_plugins.json under $CLAUDE_CONFIG_DIR), which nix never
  # wrote and will not clean:
  #   claude plugin uninstall superpowers@claude-plugins-official
  #   claude plugin marketplace remove claude-plugins-official
  #   claude plugin list
  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
    }
  );
in
{
  inherit
    mkAgent
    envContract
    piWrapped
    agentPkgs
    ghWrapped
    claudeSettings
    ;
}
