{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.steambox;
  display = config.mine.system.display;
in
{
  options.mine.user.steambox = {
    enable = mkEnableOption "Steambox auto-launch";
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = display.width != null;
        message = "mine.system.display.width must be set to use steambox";
      }
      {
        assertion = display.height != null;
        message = "mine.system.display.height must be set to use steambox";
      }
      {
        assertion = display.framerate != null;
        message = "mine.system.display.framerate must be set to use steambox";
      }
    ];

    mine.user.fish.enable = true;
    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1
        exec gamescope -W ${toString display.width} -H ${toString display.height} -r ${toString display.framerate} \
        -f -e --xwayland-count 2 \
        -- steam -gamepadui
      end
    '';
  };
} 

