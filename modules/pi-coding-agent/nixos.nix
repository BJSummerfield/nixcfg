{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) genAttrs mkEnableOption mkIf mkOption range types;
  cfg = config.mine.system.pi-coding-agent;

  instanceNames = map (i: "pi-${toString i}") (range 1 cfg.instances);

  # Script body lives in launcher.sh; only the pool parameters are
  # injected here so the shell reads as plain shell.
  launcher = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail
    instances="${toString instanceNames}"
    max_instances=${toString cfg.instances}
    ${builtins.readFile ./launcher.sh}
  '';
in
{
  options.mine.system.pi-coding-agent = {
    enable = mkEnableOption "pi coding agent, each session in its own ephemeral nspawn container";
    instances = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "Maximum number of concurrently running agent sessions (size of the container pool).";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ launcher ];

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

      config = import ./container.nix { inherit inputs; };
    });
  };
}
