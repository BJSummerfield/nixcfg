{ pkgs, lib, config, ... }:
{
  options.mine.user.keybase.enable = lib.mkEnableOption "Enable Keybase config";
  config = lib.mkIf config.mine.user.keybase.enable {
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
