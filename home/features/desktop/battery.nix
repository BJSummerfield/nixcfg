{ config
, lib
, pkgs
, ...
}:
with lib; let
  cfg = config.features.desktop.battery;
in
{
  options.features.desktop.battery.enable =
    mkEnableOption "Get battery status through notifications";

  config = mkIf cfg.enable {

    systemd.services.batteryNotify = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${pkgs.bash}/bin/bash ./battery.sh";
        Restart = "always";
      };
    };

    home.packages = with pkgs; [
      libnotify
    ];
  };
}
