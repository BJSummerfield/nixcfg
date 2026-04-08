{ lib, config, pkgs, ... }:
{
  options.mine.system.jellybox.enable = lib.mkEnableOption "Jellybox system dependencies";
  config = lib.mkIf config.mine.system.jellybox.enable {

    boot.loader.timeout = 5;
    boot.kernelParams = [ "jellybox" ];
    services.getty.autologinUser = "jellyuser";


    specialisation.desktop.configuration = {
      boot.kernelParams = lib.mkForce [ ];
      services.getty.autologinUser = lib.mkForce null;

      # this is to stop laptop power events with the screen
      services.logind.lidSwitch = lib.mkForce "suspend";
      services.logind.lidSwitchDocked = lib.mkForce "ignore";
      services.logind.lidSwitchExternalPower = lib.mkForce "ignore";
    };

    mine.system.gamescope.enable = true;
    programs.gamescope.capSysNice = true;

    environment.systemPackages = with pkgs; [
      jellyfin-media-player
    ];
  };
}
