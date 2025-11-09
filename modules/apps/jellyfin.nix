{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption optionals;
  inherit (config.mine) user;
  cfg = config.mine.apps.jellyfin;
in
{
  options.mine.apps.jellyfin = {
    tui = mkEnableOption "Enable Jellyfin-tui config";
  };

  config = {
    home-manager.users.${user.name} = {
      home.packages = with pkgs; [
        (optionals cfg.tui [ jellyfin-tui ])
      ];
    };
  };
}
