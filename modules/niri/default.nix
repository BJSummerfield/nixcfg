{ config, lib, ... }:
{
  options.mine.system.niri.enable = lib.mkEnableOption "Enable niri config";
  config = lib.mkIf config.mine.system.niri.enable {
    programs.niri.enable = true;
    home-manager.sharedModules = [ ./home.nix ];
  };
}
