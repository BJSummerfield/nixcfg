{ config, lib, ... }:
with lib; let
  cfg = config.features.desktop.wofi;
in
{
  options.features.desktop.wofi.enable = mkEnableOption "Enable wofi config";
  config = mkIf cfg.enable {
    programs.wofi = {
      enable = true;
      settings = {
        columns = 2;
        allow_images = true;
      };
    };
  };
}
