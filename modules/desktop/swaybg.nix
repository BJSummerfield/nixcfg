{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swaybg;
in
{
  options.mine.desktop.swaybg = {
    enable = mkEnableOption "Enable swaybg config";
    wallpaper = mkOption {
      type = types.str;
      default = "mountain.jpg";
    };
  };

  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
      home.file = {
        ".config/swaybg/${cfg.wallpaper}".source = ./wallpapers/${cfg.wallpaper};
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
  };
}
