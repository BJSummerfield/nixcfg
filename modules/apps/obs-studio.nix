{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.obs-studio;
in
{
  options.mine.apps.obs-studio.enable = mkEnableOption "Enable obs-studio config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.obs-studio = {
        enable = true;
        plugins = with pkgs.obs-studio-plugins; [
          wlrobs
          obs-pipewire-audio-capture
        ];
      };
    };
  };
}
