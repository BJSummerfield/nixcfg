{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.desktop.keybase;
in
{

  options.features.desktop.keybase.enable = mkEnableOption "Enable Keybase config";
  config = mkIf cfg.enable {

    services = {
      keybase.enable = true;
      kbfs.enable = true;
    };

    home.packages = with pkgs; [
      keybase-gui
      keybase
    ];
  };
}
