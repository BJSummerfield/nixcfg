{ lib, config, ... }:
let
  hmUsers = config.home-manager.users;
  anyUserWantsSteambox = lib.any
    (u: u.mine.user.steambox.enable or false)
    (lib.attrValues hmUsers);
in
{
  config = lib.mkIf anyUserWantsSteambox {
    mine.system.steam.enable = true;
    mine.system.gamescope.enable = true;
    programs.gamescope = {
      capSysNice = true;
    };
    programs.steam.gamescopeSession.enable = true;
  };
}
