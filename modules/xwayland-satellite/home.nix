{ pkgs, config, lib, ... }:
{
  options.mine.user.xwayland-satellite = {
    enable = lib.mkEnableOption "User XWayland Satellite ";
  };

  config = lib.mkIf config.mine.user.xwayland-satellite.enable {
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
}
