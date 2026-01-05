{ pkgs, lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.swayidle;
  brightnessctl = "${pkgs.brightnessctl}/bin/brightnessctl";
  niri = "${pkgs.niri}/bin/niri";
  swaylock = "${pkgs.swaylock-effects}/bin/swaylock";
  lock = "${swaylock} --ignore-empty-password --daemonize";
  display = status: "${niri} msg action power-${status}-monitors";

  brightness_dim = "${brightnessctl} -s set 10";
  brightness_restore = "${brightnessctl} -r";
in
{
  options.mine.user.swayidle.enable = mkEnableOption "Enable swayidle config for Niri";

  config = mkIf cfg.enable {
    services.swayidle = {
      enable = true;
      systemdTarget = "graphical-session.target";

      timeouts = [
        {
          timeout = 150;
          command = brightness_dim;
          resumeCommand = brightness_restore;
        }
        {
          timeout = 300;
          command = lock;
        }
        {
          timeout = 330;
          command = display "off";
          resumeCommand = "${display "on"}; ${brightness_restore}";
        }
        {
          timeout = 1800;
          command = "${pkgs.systemd}/bin/systemctl suspend";
        }
      ];

      events = {
        before-sleep = lock;
        after-resume = "${display "on"}; ${brightness_restore}";
        lock = lock;
      };
    };
  };
}
