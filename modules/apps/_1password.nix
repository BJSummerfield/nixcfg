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

    sshAgent = mkOption {
      type = types.bool;
      default = true;
      description = "Enable SSH agent in 1password";
    };

    gitSigning = mkOption {
      type = types.bool;
      default = true;
      description = "Enable 1password git signing";
    };

    ghPlugin = mkOption {
      type = types.bool;
      default = true;
      description = "Enable 1password gh shell plugin";
    };
  };

  config = mkIf cfg.enable {
    mine.system.allowUnfree.enable = true;

    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = mkIf polkit.enable [ user.name ];
    };

    home-manager.users.${user.name} = {
      imports = [ _1passwordShellModules ];

      programs._1password-shell-plugins = mkIf cfg.ghPlugin.enable {
        enable = true;
        plugins = with pkgs; [ gh ];
      };

      # TODO this may need to be broken out
      programs.ssh = mkIf cfg.sshAgent.enable {
        enable = true;
        extraConfig = ''
          Host *
              IdentityAgent ~/.1password/agent.sock              
        '';
      };
    };
  };
}
