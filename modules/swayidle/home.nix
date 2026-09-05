{
  pkgs,
  lib,
  config,
  ...
}:

let
  inherit (lib)
    mkEnableOption
    mkIf
    getExe
    getExe'
    ;
  cfg = config.mine.user.swayidle;
  brightnessctl = getExe pkgs.brightnessctl;
  niri = getExe pkgs.niri;
  # swaylock-effects' mainProgram is "swaylock", diverging from the attr name;
  # getExe' makes the divergence explicit instead of relying on getExe's guess.
  swaylock = getExe' pkgs.swaylock-effects "swaylock";
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
      systemdTargets = [ "graphical-session.target" ];

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
        inherit lock;
      };
    };
  };
}
