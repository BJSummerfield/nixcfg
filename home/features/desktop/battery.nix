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

    systemd.user.services.batteryNotify =
      let
        batteryScript = pkgs.writeShellScript "battery.sh" ''
          get_battery() {
              cat /sys/class/power_supply/BAT0/capacity
          }

          while true; do
            battery=$(get_battery)

            if [ "$battery" -gt 50 ]; then
                sleep 600   # 10 minutes when battery > 50%
            elif [ "$battery" -gt 20 ]; then
                notify-send -t 5000 -u normal "Battery Status" "Battery status: $battery%"
                sleep 600   # 10 minutes when battery is between 21% and 50%
            elif [ "$battery" -gt 10 ]; then
                notify-send -t 8000 -u normal "Battery Warning" "Battery low: $battery%"
                sleep 120   # 2 minutes when battery is between 11% and 20%
            else
                notify-send -t 15000 -u critical "Battery Critical" "Battery critically low: $battery%"
                sleep 60    # 1 minute when battery is 10% or lower
            fi
          done
        '';
      in
      {
        Unit = {
          Description = "Battery Charge Notifications";
          After = [ "graphical-session.target" ];
          PartOf = [ "graphical-session.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = "${batteryScript}";
          Restart = "always";
        };
        Install = {
          WantedBy = [ "default.target" ];
        };
      };

    home.packages = with pkgs; [
      libnotify
    ];
  };
}
