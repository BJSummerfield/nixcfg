{ lib, config, systemCfg, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.steambox;
  monitors = systemCfg.monitors;
  primary = builtins.head (lib.attrValues monitors);
in
{
  options.mine.user.steambox = {
    enable = mkEnableOption "Steambox auto-launch";
  };
  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = monitors != { };
        message = "Steambox requires at least one monitor defined in mine.system.monitors";
      }
    ];
    mine.user.fish.enable = true;
    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1
        exec gamescope -W ${toString primary.width} -H ${toString primary.height} -r ${primary.refreshRate} \
        -f -e --xwayland-count 2 \
        -- steam -gamepadui
      end
    '';
  };
}
