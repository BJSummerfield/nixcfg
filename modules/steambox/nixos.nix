{ lib, config, ... }:
{
  options.mine.system.steambox.enable = lib.mkEnableOption "Steambox system dependencies";

  config = lib.mkIf config.mine.system.steambox.enable {
    mine.system.steam.enable = true;
    mine.system.gamescope.enable = true;
    programs.gamescope.capSysNice = true;
    programs.steam.gamescopeSession.enable = true;
  };
}
