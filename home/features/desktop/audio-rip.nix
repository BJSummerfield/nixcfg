{ config, lib, pkgs, ... }:
with lib; let
  cfg = config.features.desktop.audio-rip;
in
{
  options.features.desktop.audio-rip.enable = mkEnableOption "Enable audio-rip config";
  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      abcde
      picard
    ];
  };
}
