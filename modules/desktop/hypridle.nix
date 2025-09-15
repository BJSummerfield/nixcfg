{ lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.hypridle;
in
{
  options.mine.desktop.hypridle.enable = mkEnableOption "Enable hypridle config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services.hypridle = {
        enable = true;
        settings = {
          general = {
            # avoid starting multiple hyprlock instances.
            lock_cmd = "pidof hyprlock || hyprlock";
            # to avoid having to press a key twice to turn on the display.
            after_sleep_cmd = "hyprctl dispatch dpms on";
          };

          listener = [
            {
              # 2.5min timeout for screen dimming
              timeout = 150;
              on-timeout = "brightnessctl -s set 10";
              on-resume = "brightnessctl -r";
            }
            {
              # 5min timeout for locking the session
              timeout = 300;
              on-timeout = "loginctl lock-session";
            }
            {
              # 5.5min timeout for turning off the display
              timeout = 330;
              on-timeout = "hyprctl dispatch dpms off";
              # screen on and restore brightness when activity is detected.
              on-resume = "hyprctl dispatch dpms on && brightnessctl -r";
            }
            {
              # 30min timeout for suspending the system
              timeout = 1800;
              on-timeout = "systemctl suspend";
            }
          ];
        };
      };
    };
  };
}
