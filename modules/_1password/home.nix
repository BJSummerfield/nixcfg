{ pkgs, lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user._1password;
in
{

  options.mine.user._1password = {
    enable = mkEnableOption "1Password User Config";
    silentStart.enable = mkEnableOption "Start 1Password silently with graphical session";
  };

  config = mkIf cfg.enable {
    mine.allowedUnfree = [
      "1password"
      "1password-cli"
    ];

    programs.firefox.policies.ExtensionSettings = {
      "{d634138d-c276-4fc8-924b-40a0ea21d284}" = {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi";
        installation_mode = "force_installed";
        private_browsing = true;
      };
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
        ExecStart = "${lib.getExe' pkgs._1password-gui "1password"} --silent";
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
