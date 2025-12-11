{ pkgs, lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swayidle; # Updated config path
  # Lock command (using swaylock)
  # --daemonize is recommended for swayidle to allow it to fork and continue
  lock = "${pkgs.swaylock}/bin/swaylock -f --daemonize";

  # Display command helper for Niri
  # This dynamically creates the command string based on the template you provided
  display = status: "${pkgs.niri}/bin/niri msg action power-${status}-monitors";

  # Brightness commands
  brightness_dim = "${pkgs.brightnessctl}/bin/brightnessctl -s set 10";
  brightness_restore = "${pkgs.brightnessctl}/bin/brightnessctl -r";
in
{
  # Updated option name
  options.mine.desktop.swayidle.enable = mkEnableOption "Enable swayidle config for Niri";

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services.swayidle = {
        enable = true;

        # Ensure swayidle starts after the graphical session
        systemdTarget = "graphical-session.target";

        timeouts = [
          {
            # 2.5min (150s): Dim screen
            timeout = 5;
            command = brightness_dim;
            resumeCommand = brightness_restore;
          }
          {
            # 5min (300s): Lock session
            timeout = 10;
            command = lock;
          }
          {
            # 5.5min (330s): Turn off display (Niri)
            timeout = 15;
            command = display "off";
            # Resume: Turn display on AND restore brightness (matching your hypridle logic)
            resumeCommand = "${display "on"}; ${brightness_restore}";
          }
          {
            # 30min (1800s): Suspend system
            timeout = 20;
            command = "${pkgs.systemd}/bin/systemctl suspend";
          }
        ];

        events = [
          {
            # Lock before system goes to sleep
            event = "before-sleep";
            command = lock;
          }
          {
            # Ensure screen is on and brightness is restored when waking up
            event = "after-resume";
            command = "${display "on"}; ${brightness_restore}";
          }
          {
            # Handle manual "lock" signals (e.g. loginctl lock-session)
            event = "lock";
            command = lock;
          }
        ];
      };
    };
  };
} { pkgs, lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swayidle; # Updated config path

  # --- Commands ---

  # Lock command (using swaylock)
  # --daemonize is recommended for swayidle to allow it to fork and continue
  lock = "${pkgs.swaylock}/bin/swaylock -f --daemonize";

  # Display command helper for Niri
  # This dynamically creates the command string based on the template you provided
  display = status: "${pkgs.niri}/bin/niri msg action power-${status}-monitors";

  # Brightness commands
  brightness_dim = "${pkgs.brightnessctl}/bin/brightnessctl -s set 10";
  brightness_restore = "${pkgs.brightnessctl}/bin/brightnessctl -r";
in
{
  # Updated option name
  options.mine.desktop.swayidle.enable = mkEnableOption "Enable swayidle config for Niri";

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services.swayidle = {
        enable = true;

        # Ensure swayidle starts after the graphical session
        systemdTarget = "graphical-session.target";

        timeouts = [
          {
            # 2.5min (150s): Dim screen
            timeout = 150;
            command = brightness_dim;
            resumeCommand = brightness_restore;
          }
          {
            # 5min (300s): Lock session
            timeout = 300;
            command = lock;
          }
          {
            # 5.5min (330s): Turn off display (Niri)
            timeout = 330;
            command = display "off";
            # Resume: Turn display on AND restore brightness (matching your hypridle logic)
            resumeCommand = "${display "on"}; ${brightness_restore}";
          }
          {
            # 30min (1800s): Suspend system
            timeout = 1800;
            command = "${pkgs.systemd}/bin/systemctl suspend";
          }
        ];

        events = [
          {
            # Lock before system goes to sleep
            event = "before-sleep";
            command = lock;
          }
          {
            # Ensure screen is on and brightness is restored when waking up
            event = "after-resume";
            command = "${display "on"}; ${brightness_restore}";
          }
          {
            # Handle manual "lock" signals (e.g. loginctl lock-session)
            event = "lock";
            command = lock;
          }
        ];
      };
    };
  };
}
