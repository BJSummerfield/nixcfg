{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swaylock;
in
{
  options.mine.desktop.swaylock.enable = mkEnableOption "Enable swaylock config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      service.swaylock.enable = true;
      enable = true;
    };
  };
}
