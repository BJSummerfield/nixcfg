{ config, lib, pkgs, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.polkit-gnome;
in
{
  options.mine.desktop = {
    polkit-gnome = {
      enable = mkEnableOption "Enable Gnome Polkit Authentication Agent (polkit-gnome)";
    };
  };

  config = mkIf cfg.enable {
    mine.system.polkit.enable = true;
    home-manager.users.${user.name} = {
      systemd = {
        user.services.polkit-gnome-authentication-agent-1 = {
          Unit = {
            Description = "Gnome Polkit Authentication";
            PartOf = [ "graphical-session.target" ];
            After = [ "graphical-session.target" ];
          };
          Service = {
            Type = "simple";
            ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
            TimeoutStopSec = "5sec";
            Restart = "on-failure";
          };
          Install = {
            WantedBy = [ "graphical-session.target" ];
          };
        };
      };
      home.packages = with pkgs; [
        polkit_gnome
      ];
    };
  };
}
