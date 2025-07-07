{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.keybase;
in
{
  options.mine.apps.keybase.enable = mkEnableOption "Enable Keybase config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services = {
        keybase.enable = true;
        kbfs.enable = true;
      };

      home.packages = with pkgs; [
        keybase-gui
        keybase
      ];
    };
  };
}
