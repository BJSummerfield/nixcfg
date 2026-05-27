{ pkgs, config, lib, ... }:
let
  cfg = config.mine.user.niri;
in
{
  options.mine.user.niri = {
    enable = lib.mkEnableOption "Enable niri home config";
    extraConfig = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = ''
        Extra KDL fragments contributed by other modules or the host.
        All contributions are concatenated and written to
        ~/.config/niri/dynamic.kdl, which is included by the base config.
      '';
    };
    extraBinds = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Keybind contributions, wrapped in a binds { } block in binds.kdl";
    };
  };
  config = lib.mkIf cfg.enable {
    mine.user._1password.silentStart.enable = true;
    xdg.portal = {
      enable = true;
      extraPortals = with pkgs; [
        xdg-desktop-portal-gnome
        xdg-desktop-portal-gtk
      ];
      config.common.default = [ "gnome" "gtk" ];
    };
    home.packages = with pkgs; [
      brightnessctl
      wl-clipboard
      nautilus
      xwayland-satellite
    ];
    xdg.configFile."niri/config.kdl".source = ./config.kdl;
    xdg.configFile."niri/dynamic.kdl".text = cfg.extraConfig;
    xdg.configFile."niri/binds.kdl".text = lib.optionalString (cfg.extraBinds != "") ''
      binds {
      ${cfg.extraBinds}
      }
    '';
  };
}
