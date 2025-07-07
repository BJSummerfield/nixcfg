{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.mako;
in
{
  options.mine.desktop.mako.enable = mkEnableOption "Enable Mako config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services.mako = {
        enable = true;
        settings = {
          border-size = 1;
          default-timeout = 6000;
        };
      };
    };
  };
}
