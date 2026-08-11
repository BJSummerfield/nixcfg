{
  lib,
  config,
  pkgs,
  themeConstants,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.swaylock;
  inherit (themeConstants) colors;
in
{
  options.mine.user.swaylock.enable = mkEnableOption "Enable swaylock config";
  config = mkIf cfg.enable {
    programs.swaylock = {
      enable = true;
      package = pkgs.swaylock-effects;
      settings = {
        screenshots = true;
        clock = true;
        indicator = true;
        indicator-radius = 100;
        indicator-thickness = 7;
        effect-blur = "7x5";
        effect-vignette = "0.5:0.5";
        fade-in = 1;

        color = colors.base00;
        inside-color = colors.base00;
        inside-caps-lock-color = colors.base00;
        inside-clear-color = colors.base00;
        inside-ver-color = colors.base00;
        inside-wrong-color = colors.base00;
        key-hl-color = colors.base0B;
        layout-bg-color = colors.base00;
        layout-border-color = colors.base01;
        layout-text-color = colors.base05;
        line-uses-inside = true;
        ring-color = colors.base01;
        ring-caps-lock-color = colors.base01;
        ring-clear-color = colors.base08;
        ring-ver-color = colors.base0B;
        ring-wrong-color = colors.base08;
        separator-color = "00000000";
        text-color = colors.base05;
        text-caps-lock-color = colors.base05;
        text-clear-color = colors.base05;
        text-ver-color = colors.base05;
        text-wrong-color = colors.base05;
      };
    };
  };
}
