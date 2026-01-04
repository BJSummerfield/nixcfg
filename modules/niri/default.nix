{ config, lib, ... }:
let
  cfg = config.mine.system.niri;
in
{
  options.mine.system.niri = {
    enable = lib.mkEnableOption "Enable niri config";
  };

  config = lib.mkIf cfg.enable {
    programs.niri.enable = true;
    # mine.desktop.xwayland-satellite.enable = true;
    # mine.apps._1password.silentStartOnGraphical = true;
    home-manager.sharedModules = [ ./home.nix ];
  };
}
