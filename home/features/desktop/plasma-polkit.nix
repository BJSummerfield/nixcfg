{ config, lib, pkgs, ... }:

with lib; let
  cfg = config.features.desktop.plasma-polkit;
in
{
  options.features.desktop.plasma-polkit.enable = mkEnableOption "Enable Plasma Polkit Authentication Agent";

  config = mkIf cfg.enable {
    home.packages = [ pkgs.kdePackages.polkit-kde-agent-1 ];

    systemd.user.services.plasma-polkit-agent = {
      Unit = {
        Description = "KDE Polkit Authentication Agent";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };

      Service = {
        Type = "simple";
        ExecStart = "${pkgs.kdePackages.polkit-kde-agent-1}/libexec/polkit-kde-authentication-agent-1";
        Restart = "on-failure";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
