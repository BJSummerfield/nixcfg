{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.jellyfin;
in
{
  options.mine.apps.jellyfin = {
    tui = mkEnableOption "Enable Jellyfin tui";
    media-player = mkEnableOption "Enable Jellyfin Media Player";
  };

  config = {
    home-manager.users.${user.name} = {
      programs.jellyfin-tui = mkIf cfg.tui;
      programs.jellyfin-media-player = mkIf cfg.mediaplayer;
    };
  };
}
