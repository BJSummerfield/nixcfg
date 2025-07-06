{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf types mkOption;
  cfg = config.mine.apps.steam;
in
{
  options.mine.apps.steam = {
    enable = mkEnableOption "Enable Steam";
    gamescope = mkOption {
      type = types.bool;
      default = false;
    };
    remotePlay = mkOption {
      type = types.bool;
      default = false;
    };
  };

  config = mkIf cfg.enable {
    mine.cli-tools.gamescope = mkIf cfg.gamescope true;
    programs.steam = {
      enable = true;
      gamescopeSession.enable = mkIf cfg.gamescope true;
      remotePlay.openFirewall = mkIf cfg.remotePlay true;
    };
  };
}
