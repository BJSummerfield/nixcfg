{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.user.swaybg;
  wallpaper = "mountain.jpg";
in
{
  options.mine.user.swaybg = {
    enable = mkEnableOption "Enable swaybg config";
  };

  config = mkIf cfg.enable {
    home.file = {
      ".config/swaybg/${wallpaper}".source = ../wallpapers/${wallpaper};
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
          ${pkgs.swaybg}/bin/swaybg -m fill -i "${user.homeDir}/.config/swaybg/${user.wallpaper}"
        '';
        Restart = "on-failure";
        RestartSec = "1s";
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    mine.user.niri.extraWindowRules = ''
      layer-rule {
          match namespace="^wallpaper$"
          place-within-backdrop true
      }
    '';

    home.packages = with pkgs; [
      swaybg
    ];
  };
}
