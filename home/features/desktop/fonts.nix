{ config
, lib
, pkgs
, ...
}:
with lib; let
  cfg = config.features.desktop.fonts;
in
{
  options.features.desktop.fonts.enable =
    mkEnableOption "install additional fonts for desktop apps";

  config = mkIf cfg.enable {

    fonts.fontconfig.enable = true;

    home.packages = with pkgs; [
      nerd-fonts.monaspace
    ];
  };
}
