{ config, lib, ... }:
{
  options.mine.system.niri.enable = lib.mkEnableOption "Enable niri config";
  config = lib.mkIf config.mine.system.niri.enable {
    environment.sessionVariables.NIXOS_OZONE_WL = "1";
    programs.niri.enable = true;
  };
}
