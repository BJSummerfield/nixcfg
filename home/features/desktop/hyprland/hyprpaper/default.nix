{ config, ... }:
{
  services.hyprpaper = {
    enable = true;
    settings = {
      # ipc = "on";
      # splash = false;
      # splash_offset = 2.0;

      preload = [ "${config.home.homeDirectory}/wallpapers/MistyTrees.jpg" ];
      wallpaper = [ " , ${config.home.homeDirectory}/wallpapers/MistyTrees.jpg" ];
    };
  };

  home.file = {
    "wallpapers".source = ./wallpapers;
  };
}
