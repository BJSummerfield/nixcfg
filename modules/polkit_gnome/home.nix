{ config, lib, pkgs, ... }:
{
  options.mine.user.polkit-gnome.enable = lib.mkEnableOption "Enable Gnome Polkit Authentication Agent (polkit-gnome)";
  config = lib.mkIf config.mine.user.polkit-gnome.enable {
    # systemd = {
    #   user.services.polkit-gnome-authentication-agent-1 = {
    #     Unit = {
    #       Description = "Gnome Polkit Authentication";
    #       PartOf = [ "graphical-session.target" ];
    #       After = [ "graphical-session.target" ];
    #     };
    #     Service = {
    #       Type = "simple";
    #       ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
    #       TimeoutStopSec = "5sec";
    #       Restart = "on-failure";
    #     };
    #     Install = {
    #       WantedBy = [ "graphical-session.target" ];
    #     };
    #   };
    # };


    systemd.user.services.polkit-kde-agent = {
      description = "PolicyKit KDE Authentication Agent";
      wantedBy = [ "graphical-session.target" ];
      wants = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.kdePackages.polkit-kde-agent-1}/libexec/polkit-kde-authentication-agent-1";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
      };
    };
    # services.polkit-gnome.enable = true;

    # security.polkit.enable = true;
    # home.packages = with pkgs; [
    #   polkit_gnome
    # ];
  };
}
