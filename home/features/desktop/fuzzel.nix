{ config, lib, ... }:
with lib; let
  cfg = config.features.desktop.fuzzel;
in
{
  options.features.desktop.fuzzel.enable = mkEnableOption "Enable fuzzel config";
  config = mkIf cfg.enable {
    programs.fuzzel = {
      enable = true;
      settings.main.launch-prefix = "uwsm app -- ";
    };
  };
}
