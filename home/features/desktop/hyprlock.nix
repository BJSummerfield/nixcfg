{ config, lib, ... }:
with lib; let
  cfg = config.features.desktop.hyprlock;
in
{
  options.features.desktop.hyprlock.enable = mkEnableOption "Enable hyprlock config";
  config = mkIf cfg.enable {
    programs.hyprlock = {
      enable = true;
      extraConfig = "$font = MonaspiceNe Nerd Font";
    };
  };
}
