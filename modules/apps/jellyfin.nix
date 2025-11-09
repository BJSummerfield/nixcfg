{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.jellyfin;
in
{
  options.mine.apps.jellyfin = {
    enable = mkEnableOption "Enable Jellyfin-tui config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      home.packages = with pkgs; [
        jellyfin-tui
      ];
    };
  };
}
