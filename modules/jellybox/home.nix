{ lib, config, systemCfg, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.jellybox;
  monitors = systemCfg.monitors;
  primary = builtins.head (lib.attrValues monitors);
in
{
  options.mine.user.jellybox.autoStart.enable =
    mkEnableOption "Jellyfin auto-launch on login";

  config = mkIf cfg.autoStart.enable {
    assertions = [
      {
        assertion = monitors != { };
        message = "jellybox autoStart requires at least one monitor defined in mine.system.monitors";
      }
    ];

    mine.user.fish.enable = true;

    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1; and grep -q jellybox /proc/cmdline
        exec gamescope -W ${toString primary.width} -H ${toString primary.height} -r ${primary.refreshRate} \
        -f -e \
        -- jellyfin-media-player --fullscreen --tv
      end
    '';
  };
}
