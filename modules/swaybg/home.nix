{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  cfg = config.mine.user.swaybg;
  niriCfg = config.mine.user.niri;
  wallpaper = "mountain.jpg";
in
{
  options.mine.user.swaybg = {
    enable = mkEnableOption "Enable swaybg config";
  };
  config = mkIf cfg.enable (mkMerge [
    {
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
            ${pkgs.swaybg}/bin/swaybg -m fill -i "${config.home.homeDirectory}/.config/swaybg/${wallpaper}"
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
    }
    (mkIf niriCfg.enable {
      mine.user.niri.extraConfig = ''
        layer-rule {
            match namespace="^wallpaper$"
            place-within-backdrop true
        }
      '';
    })
  ]);
}
