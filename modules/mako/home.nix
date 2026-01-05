{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.mako;
in
{
  options.mine.user.mako.enable = mkEnableOption "Enable Mako config";
  config = mkIf cfg.enable {
    services.mako = {
      enable = true;
      settings = {
        border-size = 1;
        default-timeout = 6000;
      };
    };
  };
}
