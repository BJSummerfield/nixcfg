{ config, lib, pkgs, ... }:
{
  options.mine.user.polkit-gnome.enable = lib.mkEnableOption "Enable Gnome Polkit Authentication Agent (polkit-gnome)";
  config = lib.mkIf config.mine.user.polkit-gnome.enable {
    systemd = {
      user.services.polkit-gnome-authentication-agent-1 = {
        Unit = {
          Description = "Gnome Polkit Authentication";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
          TimeoutStopSec = "5sec";
          Restart = "on-failure";
        };
        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };
    };
    home.packages = with pkgs; [
      polkit_gnome
    ];
  };
}
