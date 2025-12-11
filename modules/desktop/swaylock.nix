{ pkgs, config, lib, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swaylock;
  fontName = config.mine.system.fonts.name;
in
{
  options.mine.desktop.swaylock.enable = mkEnableOption "Enable swaylock config";

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
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
          grace = 2;
          fade-in = 0.2;

          font = fontName;
          font-size = 24;
        };
      };
    };
  };
}
