{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.jellybox;
in
{
  options.mine.user.jellybox.autoStart.enable =
    mkEnableOption "Jellyfin auto-launch on login";

  config = mkIf cfg.autoStart.enable {

    mine.user.fish.enable = true;

    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1; and grep -q jellybox /proc/cmdline
        exec gamescope \
        -f -e \
        -- jellyfin-media-player --fullscreen --tv
      end
    '';
  };
}
