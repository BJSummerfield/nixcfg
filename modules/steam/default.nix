{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.steam;
in
{
  options.mine.system.steam = {
    enable = mkEnableOption "Enable Steam";
    remotePlay = mkEnableOption "Steam remotePlay";
  };

  config = mkIf cfg.enable {
    programs.steam = {
      enable = true;
      remotePlay.openFirewall = mkIf cfg.remotePlay true;
    };
  };
}
