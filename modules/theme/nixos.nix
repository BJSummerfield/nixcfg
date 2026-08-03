{ lib, pkgs, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption types;
  cfg = config.mine.system.theme;
  defaultConstants = import ./constants.nix;
  # Host overrides merged into the full constants set.
  themeConstants = defaultConstants // {
    fonts = defaultConstants.fonts // { sizes = cfg.fontSizes; };
  };
in
{
  options.mine.system.theme = {
    enable = mkEnableOption "System theming (fonts, cursor, gtk, qt)";
    fontSizes = {
      applications = mkOption {
        type = types.int;
        default = defaultConstants.fonts.sizes.applications;
        description = "Font size for GTK/Qt applications.";
      };
      terminal = mkOption {
        type = types.int;
        default = defaultConstants.fonts.sizes.terminal;
        description = "Font size for terminal emulators.";
      };
      desktop = mkOption {
        type = types.int;
        default = defaultConstants.fonts.sizes.desktop;
        description = "Font size for desktop environment.";
      };
      popups = mkOption {
        type = types.int;
        default = defaultConstants.fonts.sizes.popups;
        description = "Font size for notification popups.";
      };
    };
  };

  config = mkMerge [
    {
      home-manager.extraSpecialArgs = {
        inherit themeConstants;
      };
    }

    (mkIf cfg.enable {
      fonts = {
        packages = [
          pkgs.nerd-fonts.monaspace
          pkgs.noto-fonts-color-emoji
        ];
        fontconfig.defaultFonts = {
          serif = [ themeConstants.fonts.serif.name ];
          sansSerif = [ themeConstants.fonts.sansSerif.name ];
          monospace = [ themeConstants.fonts.monospace.name ];
          emoji = [ themeConstants.fonts.emoji.name ];
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
    })
  ];
}
