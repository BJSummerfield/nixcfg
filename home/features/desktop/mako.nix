{ config, lib, ... }:
with lib; let
  cfg = config.features.desktop.mako;
in
{
  options.features.desktop.mako.enable = mkEnableOption "Enable Mako config";
  config = mkIf cfg.enable {
    services.mako = {
      enable = true;
      # font = "MonaspiceNe Nerd Font 8";
      settings = {
        border-radius = 8;
        border-size = 1;
        default-timeout = 6000;
      };
    };
  };
}
