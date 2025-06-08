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

    home.file = {
      ".config/swaybg/mountain.jpg".source = ../wallpapers/mountain.jpg;
    };


    systemd.user.services.swaybg = {
      Unit = {
        Description = "Niri Wallpaper Background";
        PartOf = [ "niri.service" ];
        After = [ "niri.service" ];
      };

      Service = {
        Type = "simple";
        ExecStart = ''
          ${pkgs.swaybg}/bin/swaybg -m fill -i "${config.home.homeDirectory}/.config/swaybg/mountain.jpg"
        '';
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "niri.service" ];
      };
    };

    home.packages = with pkgs; [
      swaybg
      brightnessctl
      wl-clipboard
      xwayland-satellite
      nautilus
    ];
  };
}
