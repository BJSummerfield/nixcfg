{ pkgs, config, lib, ... }:
with lib; let
  cfg = config.features.desktop.obs-studio;
in
{
  options.features.desktop.obs-studio.enable = mkEnableOption "Enable obs-studio config";
  config = mkIf cfg.enable {
    programs.obs-studio = {
      enable = true;
      plugins = with pkgs.obs-studio-plugins; [
        wlrobs
        obs-pipewire-audio-capture
      ];
    };
  };
}
