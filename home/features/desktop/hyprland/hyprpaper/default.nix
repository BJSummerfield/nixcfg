{ config, ... }:
{
  # services.hyprpaper = {
  #   enable = true;
  #   settings = {
  #     # ipc = "on";
  #     # splash = false;
  #     # splash_offset = 2.0;

  #     preload = [ "${config.home.homeDirectory}/wallpapers/mountain.jpg" ];
  #     wallpaper = [ " , ${config.home.homeDirectory}/wallpapers/moutain.jpg" ];
  #   };
  # };

  home.file = {
    "wallpapers".source = ./wallpapers;
  };
}
