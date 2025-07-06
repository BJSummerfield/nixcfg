{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.swaybg;
in
{
  options.mine.desktop.swaybg = {
    enable = mkEnableOption "Enable swaybg config";
  };

  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
      home.file = {
        ".config/swaybg/${user.wallpaper}".source = ./wallpapers/${user.wallpaper};
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

      home.packages = with pkgs; [
        swaybg
      ];
    };
  };
}
