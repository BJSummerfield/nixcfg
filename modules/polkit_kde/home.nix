{ config, lib, pkgs, ... }:
{
  options.mine.user.polkit-kde.enable = lib.mkEnableOption "Enable kde Polkit Authentication Agent (polkit-kde)";
  config = lib.mkIf config.mine.user.polkit-kde.enable {
    systemd.user.services.polkit-kde-agent = {
      Unit = {
        Description = "PolicyKit KDE Authentication Agent";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${pkgs.kdePackages.polkit-kde-agent-1}/libexec/polkit-kde-authentication-agent-1";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
      };
      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
