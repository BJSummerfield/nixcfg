{ config, lib, pkgs, ... }:

with lib; let
  cfg = config.features.desktop.hyprpolkitagent;

in
{
  options.features.desktop.hyprpolkitagent = {
    enable = mkEnableOption "Enable Hyprland Polkit Authentication Agent (hyprpolkitagent)";
  };
  config = mkIf cfg.enable {
    systemd.user.services.hyprpolkit = {
      Unit = {
        Description = "Hyprland Polkit Authentication Agent";
        Documentation = "https://github.com/hyprwm/hyprpolkitagent";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
        ConditionEnvironment = [ "WAYLAND_DISPLAY" ];
      };

      Service = {
        Type = "simple";
        ExecStart = "${pkgs.hyprpolkitagent}/libexec/hyprpolkitagent";
        TimeoutStopSec = "5sec";
        Restart = "on-failure";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    home.packages = with pkgs; [
      hyprpolkitagent
    ];
  };
}
