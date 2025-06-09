{ pkgs, config, lib, ... }:

with lib; let
  cfg = config.features.desktop.niri;
in
{
  options.features.desktop.niri.enable = mkEnableOption "Enable niri config";
  config = mkIf cfg.enable {
    xdg.portal = {
      enable = true;
      extraPortals = with pkgs; [
        xdg-desktop-portal-gnome
        xdg-desktop-portal-gtk
      ];
      config.common.default = [
        "gnome"
        "gtk"
      ];
    };

    home.file = {
      ".config/niri/config.kdl".source = ./config.kdl;
    };

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
      brightnessctl
      wl-clipboard
      xwayland-satellite
      nautilus
    ];
  };
}
