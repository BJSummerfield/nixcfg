{ pkgs, lib, config, inputs, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  _1passwordShellModules = inputs._1password-shell-plugins.hmModules.default;
  cfg = config.mine.apps._1password;
in
{
  imports = [ _1passwordShellModules ];
  options.features.desktop._1password.enable = mkEnableOption "Enable 1password config";

  config = mkIf cfg.enable {
    programs._1password.enable = true;
    # TODO Break out polkit
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = [ user.name ];
    };

    home-manager.users.${user.name} = {
      programs._1password-shell-plugins = {
        # enable 1Password shell plugins for bash, zsh, and fish shell
        enable = true;
        # the specified packages as well as 1Password CLI will be
        # automatically installed and configured to use shell plugins
        plugins = with pkgs; [ gh ];
      };

      # TODO break this out
      programs.git = {
        extraConfig =
          {
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
