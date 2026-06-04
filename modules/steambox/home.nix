{ lib, config, systemCfg, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.steambox;
in
{
  options.mine.user.steambox.autoStart.enable =
    mkEnableOption "Steambox auto-launch on login";

  config = mkIf cfg.autoStart.enable {
    warnings = lib.optional (!(systemCfg.steambox.enable or false))
      "mine.user.steambox.autoStart is enabled but mine.system.steambox is not. Steam and gamescope may not be installed.";

    mine.user.fish.enable = true;
    programs.fish.loginShellInit = ''
      if test -z "$WAYLAND_DISPLAY" -a "$XDG_VTNR" = 1
        exec gamescope -f -e --xwayland-count 2 -- steam -gamepadui
      end
    '';
  };
}
