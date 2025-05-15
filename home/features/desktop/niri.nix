{ config, lib, ... }:
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

    home.packages = with pkgs; [
      brightnessctl
      wl-clipboard
      xwayland-satellite
      nautilus
    ];
  };
}
