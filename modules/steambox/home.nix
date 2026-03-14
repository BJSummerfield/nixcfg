{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.mine.user.steambox;
in
{
  options.mine.user.steambox = {
    enable = mkEnableOption "Steambox auto-launch";
    displayWidth = mkOption { type = types.int; default = 1920; };
    displayHeight = mkOption { type = types.int; default = 1080; };
    displayFramerate = mkOption { type = types.int; default = 60; };
  };

  config = mkIf cfg.enable {
    mine.user.fish.enable = true;
    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1
        exec gamescope -W ${toString cfg.displayWidth} -H ${toString cfg.displayHeight} -r ${toString cfg.displayFramerate} \
        -f -e --xwayland-count 2 \
        -- steam -gamepadui
      end
    '';
  };
} 

