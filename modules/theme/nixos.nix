{ lib, pkgs, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.theme;
  theme = import ./constants.nix;
in
{
  options.mine.system.theme.enable = mkEnableOption "System theming (fonts, cursor, gtk, qt)";

  config = mkIf cfg.enable {
    fonts = {
      packages = [
        pkgs.nerd-fonts.monaspace
        pkgs.noto-fonts-color-emoji
      ];
      fontconfig.defaultFonts = {
        serif = [ theme.fonts.serif.name ];
        sansSerif = [ theme.fonts.sansSerif.name ];
        monospace = [ theme.fonts.monospace.name ];
        emoji = [ theme.fonts.emoji.name ];
      };
    };

    programs.dconf.enable = true;

    qt = {
      enable = true;
      platformTheme = "qt5ct";
    };

    home-manager.sharedModules = [
      ./home.nix
    ];
  };
}
