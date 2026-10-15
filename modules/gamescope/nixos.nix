{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.gamescope;
in
{
  options.mine.system.gamescope = {
    enable = mkEnableOption "Enable gamescope compositor";
  };

  config = mkIf cfg.enable {
    programs.gamescope.enable = true;
    programs.steam.remotePlay.openFirewall = true;
  };
}
