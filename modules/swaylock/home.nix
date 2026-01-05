{ pkgs, config, lib, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.desktop.swaylock;
  stylix = config.mine.user.stylix;
in
{
  options.mine.desktop.swaylock.enable = mkEnableOption "Enable swaylock config";

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
        # grace = 2;
        fade-in = 1;
        font = stylix.fonts.monospace.name;
        font-size = 24;
      };
    };
  };
}
