{ ... }:
{
  services.hyprpaper = {
    enable = true;
    settings = {
      # ipc = "on";
      # splash = false;
      # splash_offset = 2.0;

      preload =
        [ "$Home/wallpapers/MistyTrees.jpg" ];

      wallpaper = [
        "$Home/wallpapers/MistyTrees.jpg"
      ];
    };
  };

  home.file = {
    "wallpapers".source = ./wallpapers;
  };
}
