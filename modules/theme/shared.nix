{ lib, config, ... }:
let
  defaults = import ./constants.nix;
  cfg = config.mine.system.theme;

  mkSize =
    which: default:
    lib.mkOption {
      type = lib.types.int;
      inherit default;
      description = "Font size for ${which}.";
    };
in
{
  options.mine.system.theme = {
    enable = lib.mkEnableOption "System theming (fonts, cursor, gtk, qt)";

    fontSizes = {
      applications = mkSize "applications" defaults.fonts.sizes.applications;
      terminal = mkSize "terminal emulators" defaults.fonts.sizes.terminal;
      popups = mkSize "popups" defaults.fonts.sizes.popups;
    };

    background = lib.mkOption {
      type = lib.types.str;
      default = defaults.colors.base00;
      description = "Base background colour as a hex string without the leading #.";
    };

    terminalOpacity = lib.mkOption {
      type = lib.types.float;
      default = defaults.opacity.terminal;
      description = "Background opacity of terminal emulators.";
    };

    constants = lib.mkOption {
      type = lib.types.attrs;
      internal = true;
      readOnly = true;
      description = ''
        Fully resolved theme constants: constants.nix with the host's
        overrides merged in. Passed to home-manager modules as the
        `themeConstants` module argument.
      '';
    };
  };

  config = {
    mine.system.theme.constants = defaults // {
      colors = defaults.colors // {
        base00 = cfg.background;
      };
      fonts = defaults.fonts // {
        sizes = cfg.fontSizes;
      };
      opacity = defaults.opacity // {
        terminal = cfg.terminalOpacity;
      };
    };

    home-manager.sharedModules = [
      { _module.args.themeConstants = cfg.constants; }
    ];
  };
}
