## THIS assumes we are using NIRI and HYPRLOCK
{ lib, config, pkgs, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swayidle;
in
{
  options.mine.desktop.swayidle.enable = mkEnableOption "Enable swayidle config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      services.swayidle = {
        enable = true;
        package = pkgs.swayidle;

        events = [
          {
            event = "before-sleep";
            command = "${pkgs.systemd}/bin/loginctl lock-session";
          }
          {
            event = "lock";
            command = "pidof hyprlock || ${pkgs.hyprlock}/bin/hyprlock";
          }
        ];
        timeouts = [
          {
            timeout = 150;
            command = "${pkgs.brightnessctl}/bin/brightnessctl -s set 10";
            resumeCommand = "${pkgs.brightnessctl}/bin/brightnessctl -r";
          }

          {
            timeout = 300;
            command = "${pkgs.systemd}/bin/loginctl lock-session";
          }

          {
            timeout = 330;
            command = "${pkgs.niri}/bin/niri msg action power-off-monitors";
            resumeCommand = "${pkgs.niri}/bin/niri msg action power-on-monitors";
          }

          {
            timeout = 1800;
            command = "${pkgs.systemd}/bin/systemctl suspend";
          }
        ];
      };
      systemd.user.services.swayidle.Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
