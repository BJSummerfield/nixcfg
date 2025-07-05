{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.alacritty;
in
{
  options.mine.desktop.niri = {
    enable = mkEnableOption "Enable niri config";
  };

  config = mkIf cfg.enable {
    programs.niri.enable = true;

    home-manager.users.${user.name} = {
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


      home.packages = with pkgs; [
        brightnessctl
        wl-clipboard
        xwayland-satellite
        nautilus
      ];
    };
  };
}

