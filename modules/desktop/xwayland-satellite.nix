{ pkgs, config, lib, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.xwayland-satellite;
in
{
  options.mine.desktop.xwayland-satellite = {
    enable = mkEnableOption "Enable XWayland Satellite for niri";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      home.packages = [ pkgs.xwayland-satellite ];

      systemd.user.services.xwayland-satellite = {
        Unit = {
          Description = "XWayland Satellite for niri";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session.target" ];
        };

        Service = {
          Type = "simple";
          ExecStart = "${pkgs.xwayland-satellite}/bin/xwayland-satellite";
          Restart = "on-failure";
          RestartSec = "1s";
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };
    };
  };
}
