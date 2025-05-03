{ lib, config, ... }:

with lib; let
  cfg = config.features.desktop.hypridle;
in
{

  options.features.desktop.hypridle.enable = mkEnableOption "Enable hypridle config";
  config = mkIf cfg.enable
    {
      services.hypridle = {
        enable = true;

        settings = {
          general = {
            # avoid starting multiple hyprlock instances.
            lock_cmd = "pidof hyprlock || hyprlock";
            # lock before suspend.
            before_sleep_cmd = "loginctl lock-session";
            # to avoid having to press a key twice to turn on the display.
            after_sleep_cmd = "hyprctl dispatch dpms on";
          };

          listener = [
            {
              # 2.5min timeout for screen dimming
              timeout = 10;
              # timeout = 150;
              # set monitor backlight to minimum (adjust '10' if needed, avoid 0 on OLED).
              on-timeout = "brightnessctl -s set 10";
              # monitor backlight restore.
              on-resume = "brightnessctl -r";
            }
            # Optional: turn off keyboard backlight (remove if not applicable)
            # {
            #   # 2.5min timeout for keyboard backlight
            #   timeout = 150;
            #   # turn off keyboard backlight (adjust device 'rgb:kbd_backlight' if needed).
            #   on-timeout = "brightnessctl -sd rgb:kbd_backlight set 0";
            #   # turn on keyboard backlight.
            #   on-resume = "brightnessctl -rd rgb:kbd_backlight";
            # }
            {
              # 5min timeout for locking the session
              timeout = 20;
              # timeout = 300;
              # lock screen when timeout has passed.
              on-timeout = "loginctl lock-session";
            }
            {
              # 5.5min timeout for turning off the display
              # timeout = 330;
              timeout = 30;
              # screen off when timeout has passed.
              on-timeout = "hyprctl dispatch dpms off";
              # screen on and restore brightness when activity is detected.
              on-resume = "hyprctl dispatch dpms on && brightnessctl -r";
            }
            {
              # 30min timeout for suspending the system
              timeout = 40;
              # timeout = 1800;
              # suspend pc.
              on-timeout = "systemctl suspend";
            }
          ];
        };
      };
    };
}
