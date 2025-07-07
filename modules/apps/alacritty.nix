{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.alacritty;
  fonts = config.mine.system.fonts;
in
{
  options.mine.apps.alacritty = {
    enable = mkEnableOption "Alacritty Config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.alacritty = {
        enable = true;
        settings = {
          font = {
            normal.family = mkIf fonts.enable fonts.name;
            size = 14;
          };
          window = {
            opacity = 0.8;
            decorations = "buttonless";
            padding = {
              x = 5;
              y = 5;
            };
          };
        };
      };
      home.sessionVariables = {
        TERMINAL = "alacritty";
      };
    };
  };
}
