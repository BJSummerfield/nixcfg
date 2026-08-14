{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (lib) mkIf;
  cfg = config.mine.system.theme;
  inherit (cfg) constants;
in
{
  imports = [ ./shared.nix ];

  config = mkIf cfg.enable {
    fonts = {
      packages = [
        pkgs.nerd-fonts.monaspace
        pkgs.noto-fonts-color-emoji
      ];
      fontconfig.defaultFonts = {
        serif = [ constants.fonts.serif.name ];
        sansSerif = [ constants.fonts.sansSerif.name ];
        monospace = [ constants.fonts.monospace.name ];
        emoji = [ constants.fonts.emoji.name ];
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
