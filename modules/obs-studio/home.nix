{ pkgs, config, lib, ... }:
{
  options.mine.user.obs-studio.enable = lib.mkEnableOption "Enable obs-studio config";
  config = lib.mkIf config.mine.user.obs-studio.enable {
    programs.obs-studio = {
      enable = true;
      plugins = with pkgs.obs-studio-plugins; [
        wlrobs
        obs-pipewire-audio-capture
      ];
    };
  };
}
