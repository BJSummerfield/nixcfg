{ lib, config, themeConstants, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.alacritty;
  inherit (themeConstants) colors;
  mono = themeConstants.fonts.monospace.name;
in
{
  options.mine.user.alacritty = {
    enable = mkEnableOption "Alacritty Config";
  };

  config = mkIf cfg.enable {
    programs.alacritty = {
      enable = true;
      settings = {
        font = {
          size = themeConstants.fonts.sizes.terminal;
          normal = {
            family = mono;
            style = "Regular";
          };
          bold = {
            family = mono;
            style = "Bold";
          };
          italic = {
            family = mono;
            style = "Italic";
          };
          bold_italic = {
            family = mono;
            style = "Bold Italic";
          };
        };
        colors = {
          primary = {
            background = "#${colors.base00}";
            foreground = "#${colors.base05}";
            dim_foreground = "#${colors.overlay1}";
            bright_foreground = "#${colors.base05}";
          };
          cursor = {
            text = "#${colors.base00}";
            cursor = "#${colors.base06}";
          };
          vi_mode_cursor = {
            text = "#${colors.base00}";
            cursor = "#${colors.base07}";
          };
          search = {
            matches = {
              foreground = "#${colors.base00}";
              background = "#${colors.base04}";
            };
            focused_match = {
              foreground = "#${colors.base00}";
              background = "#${colors.base0B}";
            };
          };
          footer_bar = {
            foreground = "#${colors.base00}";
            background = "#${colors.base04}";
          };
          hints = {
            start = {
              foreground = "#${colors.base00}";
              background = "#${colors.base0A}";
            };
            end = {
              foreground = "#${colors.base00}";
              background = "#${colors.base04}";
            };
          };
          selection = {
            text = "#${colors.base00}";
            background = "#${colors.base06}";
          };
          normal = {
            black = "#${colors.base02}";
            red = "#${colors.base08}";
            green = "#${colors.base0B}";
            yellow = "#${colors.base0A}";
            blue = "#${colors.base0D}";
            magenta = "#${colors.pink}";
            cyan = "#${colors.base0C}";
            white = "#${colors.subtext1}";
          };
          bright = {
            black = "#${colors.surface2}";
            red = "#${colors.base08}";
            green = "#${colors.base0B}";
            yellow = "#${colors.base0A}";
            blue = "#${colors.base0D}";
            magenta = "#${colors.pink}";
            cyan = "#${colors.base0C}";
            white = "#${colors.base04}";
          };
          indexed_colors = [
            { index = 16; color = "#${colors.base09}"; }
            { index = 17; color = "#${colors.base06}"; }
          ];
        };
        window = {
          decorations = "buttonless";
          opacity = themeConstants.opacity.terminal;
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
}
