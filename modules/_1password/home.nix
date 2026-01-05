{ pkgs, lib, config, inputs, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user._1password;
in
{
  imports = [ inputs._1password-shell-plugins.hmModules.default ];

  options.mine.user._1password = {
    enable = mkEnableOption "1Password User Config";
    silentStart.enable = mkEnableOption "Start 1Password silently with graphical session";
    ghPlugin.enable = mkEnableOption "Enable GitHub CLI integration";
    gitSigning.enable = mkEnableOption "Enable signing commits with 1Password";
    sshAgent.enable = mkEnableOption "Enable SSH Agent config for Git";
  };

  config = mkIf cfg.enable {
    mine.user.niri.extraWindowRules = ''
      // Security: Hide 1Password from screencasts/sharing
      window-rule {
          match app-id="1Password"
          block-out-from "screen-capture"
      }
    '';

    programs.firefox.policies.ExtensionSettings = {
      "{d634138d-c276-4fc8-924b-40a0ea21d284}" = {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi";
        installation_mode = "force_installed";
        private_browsing = true;
      };
    };

    programs._1password-shell-plugins = mkIf cfg.ghPlugin.enable {
      enable = true;
      plugins = [ pkgs.gh ];
    };

    programs.git = mkIf cfg.gitSigning.enable {
      enable = true;
      settings = {
        gpg.ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
      };
    };

    programs.ssh = mkIf cfg.sshAgent.enable {
      enable = true;
      enableDefaultConfig = false;
      matchBlocks."*" = {
        forwardAgent = false;
        addKeysToAgent = "no";
        compression = false;
        serverAliveInterval = 0;
        serverAliveCountMax = 3;
        hashKnownHosts = false;
        userKnownHostsFile = "~/.ssh/known_hosts";
        controlMaster = "no";
        controlPath = "~/.ssh/master-%r@%n:%p";
        controlPersist = "no";
      };
      extraConfig = ''
        Host *
            IdentityAgent ~/.1password/agent.sock              
      '';
    };

    # makes a systemd service that runs 1password --silent on execution.
    systemd.user.services."1password-silent" = mkIf cfg.silentStart.enable {
      Unit = {
        Description = "Start 1Password in the background";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };

      Service = {
        Type = "simple";
        Environment = [ "DISPLAY=:0" ];
        ExecStart = "${lib.getExe' pkgs._1password-gui}/bin/1password --silent";
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
