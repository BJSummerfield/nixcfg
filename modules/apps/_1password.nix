{ pkgs, lib, config, inputs, ... }:

let
  inherit (lib) mkEnableOption mkIf mkOption types;
  inherit (config.mine) user;
  _1passwordShellModules = inputs._1password-shell-plugins.hmModules.default;
  cfg = config.mine.apps._1password;
  polkit = config.mine.system.polkit;
in
{
  options.mine.apps._1password = {
    enable = mkEnableOption "Enable 1password config";
    silentStartOnGraphical = mkEnableOption "Start 1Password silently with the graphical session";

    sshAgent = mkOption {
      type = types.bool;
      default = false;
      description = "Enable SSH agent in 1password";
    };

    gitSigning = mkOption {
      type = types.bool;
      default = false;
      description = "Enable 1password git signing";
    };

    ghPlugin = mkOption {
      type = types.bool;
      default = false;
      description = "Enable 1password gh shell plugin";
    };
  };

  config = mkIf cfg.enable {
    mine.system.allowUnfree.enable = true;
    # Enable gh if the plugin is enabled
    mine.cli-tools.gh.enable = mkIf cfg.ghPlugin true;

    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = mkIf polkit.enable [ user.name ];
    };

    home-manager.users.${user.name} = {
      imports = [ _1passwordShellModules ];

      programs._1password-shell-plugins = mkIf cfg.ghPlugin {
        enable = true;
        plugins = with pkgs; [ gh ];
      };

      # makes a systemd service that runs 1password --silent on execution.
      systemd.user.services."1password-silent" = mkIf cfg.silentStartOnGraphical {
        Unit = {
          Description = "Start 1Password in the background";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session.target" ];
        };

        Service = {
          Type = "simple";
          Environment = [ "DISPLAY=:0" ];
          ExecStart = "${config.programs._1password-gui.package}/bin/1password --silent";
          Restart = "on-failure";
          RestartSec = "1s";
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };
    };
  };
}
