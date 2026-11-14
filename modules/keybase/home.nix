{
  pkgs,
  lib,
  config,
  ...
}:
{
  options.mine.user.keybase.enable = lib.mkEnableOption "Enable Keybase config";
  config = lib.mkIf config.mine.user.keybase.enable {
    mine.allowedInsecure = [ "keybase-gui-6.6.3" ];

    warnings =
      lib.optional (!pkgs.keybase-gui.meta.insecure)
        "keybase-gui ${pkgs.keybase-gui.version} is no longer marked insecure; remove mine.allowedInsecure from modules/keybase/home.nix";

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
