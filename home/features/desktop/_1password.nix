{ pkgs, lib, config, inputs, ... }:

with lib; let
  cfg = config.features.desktop._1password;
  _1passwordShellModules = inputs._1password-shell-plugins.hmModules.default;
in
{
  imports = [ _1passwordShellModules ];

  options.features.desktop._1password.enable = mkEnableOption "Enable 1password config";

  config = mkIf cfg.enable {

    programs._1password-shell-plugins = {
      # enable 1Password shell plugins for bash, zsh, and fish shell
      enable = true;
      # the specified packages as well as 1Password CLI will be
      # automatically installed and configured to use shell plugins
      plugins = with pkgs; [ gh ];
    };

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

    programs.ssh = {
      enable = true;
      extraConfig = ''
        Host *
            IdentityAgent ~/.1password/agent.sock              
      '';
    };

    systemd.user.services._1password-silent = {
      Unit = {
        Description = "Starts 1password silently in the background";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };

      Service = {
        Type = "simple";
        ExecStart = ''
          ${pkgs._1password}/bin/1password --silent"
        '';
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
