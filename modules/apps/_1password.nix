{ pkgs, lib, config, inputs, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  _1passwordShellModules = inputs._1password-shell-plugins.hmModules.default;
  cfg = config.mine.apps._1password;
  polkit = config.mine.system.polkit;
in
{
  options.mine.apps._1password.enable = mkEnableOption "Enable 1password config";

  config = mkIf cfg.enable {
    mine.system.allowUnfree.enable = true;

    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = mkIf polkit [ user.name ];
    };

    home-manager.users.${user.name} = {
      imports = [ _1passwordShellModules ];

      programs._1password-shell-plugins = {
        enable = true;
        plugins = with pkgs; [ gh ];
      };

      # TODO break this out
      programs.git = {
        extraConfig = {
          user.signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2G3biYuL3iFvhAXYNuVzvRpAQMmFFLek3KFZV4PfDu";
          gpg = {
            ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
            format = "ssh";
          };
          commit.gpgSign = true;
        };
      };

      # TODO break this out
      programs.ssh = {
        enable = true;
        extraConfig = ''
          Host *
              IdentityAgent ~/.1password/agent.sock              
        '';
      };
    };
  };
}
