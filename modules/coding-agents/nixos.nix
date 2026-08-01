{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) genAttrs mkIf mkOption optionals range types;
  inherit (import ./options.nix lib) mkAgentOptions;
  cfg = config.mine.system.coding-agents;

  instanceNames = map (i: "agent-${toString i}") (range 1 cfg.instances);

  # Script body lives in launcher.sh; only the pool parameters and the
  # per-agent command/state mount are injected here so the shell reads as
  # plain shell. state_src is expanded by the shell at runtime, letting it
  # reference $HOME.
  mkLauncher = { name, cmd, stateSrc ? "", stateDest ? "" }:
    pkgs.writeShellScriptBin name ''
      set -euo pipefail
      instances="${toString instanceNames}"
      max_instances=${toString cfg.instances}
      agent_cmd=${cmd}
      state_src="${stateSrc}"
      state_dest="${stateDest}"
      ${builtins.readFile ./launcher.sh}
    '';

  launchers =
    optionals cfg.agents.pi [ (mkLauncher { name = "pi"; cmd = "pi"; }) ]
    ++ optionals cfg.agents.opencode [ (mkLauncher { name = "opencode"; cmd = "opencode"; }) ]
    # Ephemeral containers, but claude's login/config state survives in a
    # dedicated host dir so auth happens once per machine, not per session.
    ++ optionals cfg.agents.claude [
      (mkLauncher {
        name = "claude";
        cmd = "claude";
        stateSrc = "$HOME/.local/state/claude-sandbox";
        stateDest = "/home/agent/.claude-state";
      })
    ];
in
{
  options.mine.system.coding-agents = mkAgentOptions // {
    instances = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "Maximum number of concurrently running agent sessions (size of the container pool).";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = launchers;

    containers = genAttrs instanceNames (_: {
      autoStart = false;
      # Empty root bootstrapped on every start, discarded on stop. Nothing
      # persists between sessions except the project mount, which is the
      # user's real directory anyway. Config and extensions come from the
      # store via home-manager; pi installs its npm packages at startup.
      ephemeral = true;
      # Shares the host network namespace: DNS, the tailnet (model
      # endpoint) and localhost all work with zero plumbing. The isolation
      # this container provides is filesystem/process, not network - the
      # agent is allowed full egress by design.
      privateNetwork = false;

      config = import ./container.nix { inherit inputs; inherit (cfg) agents; };
    });
  };
}
