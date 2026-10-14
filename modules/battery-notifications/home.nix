{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.battery-notifications;
in
{
  options.mine.user.battery-notifications.enable =
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
                sleep 600
            elif [ "$battery" -gt 20 ]; then
                notify-send -t 5000 -u normal "Battery Status" "Battery status: $battery%"
                sleep 600
            elif [ "$battery" -gt 10 ]; then
                notify-send -t 8000 -u normal "Battery Warning" "Battery low: $battery%"
                sleep 120
            else
                notify-send -t 15000 -u critical "Battery Critical" "Battery critically low: $battery%"
                sleep 60
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
          Environment = "PATH=${pkgs.libnotify}/bin:/run/current-system/sw/bin:/usr/bin:/bin";
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
