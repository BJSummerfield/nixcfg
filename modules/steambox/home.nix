{ lib, config, systemCfg, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.steambox;
  monitors = systemCfg.monitors;
  primary = builtins.head (lib.attrValues monitors);
in
{
  options.mine.user.steambox.autoStart.enable =
    mkEnableOption "Steambox auto-launch on login";

  config = mkIf cfg.autoStart.enable {
    assertions = [
      {
        assertion = monitors != { };
        message = "Steambox autoStart requires at least one monitor defined in mine.system.monitors";
      }
    ];
    warnings = lib.optional (!systemCfg.steambox.enable or false)
      "mine.user.steambox.autoStart is enabled but mine.system.steambox is not. Steam and gamescope may not be installed.";

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
