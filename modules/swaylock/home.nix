{ pkgs, config, lib, options, ... }:
let
  inherit (lib) mkEnableOption mkIf optionalAttrs;
  cfg = config.mine.user.swaylock;
in
{
  options.mine.user.swaylock.enable = mkEnableOption "Enable swaylock config";
  config = mkIf cfg.enable ({
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
      };
    };
  } // optionalAttrs (options ? stylix) {
    stylix.targets.swaylock.enable = true;
  });
}
