{ pkgs, config, lib, ... }:

with lib; let
  cfg = config.features.desktop.swaybg;
in
{
  options.features.desktop.swaybg.enable = mkEnableOption "Enable swaybg config";
  config = mkIf cfg.enable {

    home.file = {
      ".config/swaybg/mountain.jpg".source = ./wallpapers/mountain.jpg;
    };

    systemd.user.services.swaybg = {
      Unit = {
        Description = "Wallpaper Background Service";
        PartOf = [ "graphical-session.target" ];
        After = [ "graphical-session.target" ];
      };

      Service = {
        Type = "simple";
        ExecStart = ''
          ${pkgs.swaybg}/bin/swaybg -m fill -i "${config.home.homeDirectory}/.config/swaybg/mountain.jpg"
        '';
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    home.packages = with pkgs; [
      swaybg
    ];
  };
}
