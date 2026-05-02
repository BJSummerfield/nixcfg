{ pkgs, config, lib, ... }:
let
  cfg = config.mine.user.niri;
in
{
  options.mine.user.niri = {
    enable = lib.mkEnableOption "User Niri Config";

    userConfig = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a user-specific niri KDL file.
        Deployed to ~/.config/niri/user.kdl.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
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
    }

    (lib.mkIf (cfg.userConfig != null) {
      xdg.configFile."niri/user.kdl".source = cfg.userConfig;
    })
  ]);
}
