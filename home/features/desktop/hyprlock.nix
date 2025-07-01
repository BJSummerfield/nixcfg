{ config, lib, globals, ... }:
with lib; let
  cfg = config.features.desktop.hyprlock;
  base = "rgb(1e1e2e)";
  text = "rgb(cdd6f4)";
  textAlpha = "cdd6f4";
  blue = "rgb(89b4fa)";
  blueAlpha = "89b4fa";
  accent = blue;
  accentAlpha = blueAlpha;
  surface0 = "rgb(313244)";
  red = "rgb(f38ba8)";
  yellow = "rgb(f9e2af)";
in
{
  options.features.desktop.hyprlock.enable = mkEnableOption "Enable hyprlock config";
  config = mkIf cfg.enable {
    programs.hyprlock = {
      enable = true;
      settings = {
        general = {
          disable_loading_bar = true;
          hide_cursor = true;
        };

        background = {
          monitor = "";
          path = "${./wallpapers/mountain.jpg}";
          blur_passes = 1;
          color = base;
        };

        # LABELS
        label = [
          # Time Label
          {
            monitor = "";
            text = "$TIME";
            color = text;
            font_size = 90;
            font_family = globals.systemFont;
            position = "-30, 0";
            halign = "right";
            valign = "top";
          }
          # Date Label
          {
            monitor = "";
            text = "cmd[update:43200000] date +\"%A, %d %B %Y\"";
            color = text;
            font_size = 25;
            font_family = globals.systemFont;
            position = "-30, -150";
            halign = "right";
            valign = "top";
          }
        ];

        # INPUT FIELD section
        input-field = {
          monitor = "";
          size = "300, 60";
          outline_thickness = 4;
          dots_size = 0.2;
          dots_spacing = 0.2;
          dots_center = true;
          outer_color = accent;
          inner_color = surface0;
          font_color = text;
          fade_on_empty = false;
          placeholder_text = ''<span foreground="##${textAlpha}"><i>󰌾 Logged in as </i><span foreground="##${accentAlpha}">$USER</span></span>'';
          hide_input = false;
          check_color = accent;
          fail_color = red;
          fail_text = ''<i>$FAIL <b>($ATTEMPTS)</b></i>'';
          capslock_color = yellow;
          position = "0, -47";
          halign = "center";
          valign = "center";
        };
      };
    };
  };
}
