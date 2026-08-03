# Theme options and constant resolution shared by the nixos and darwin
# modules. Platform files import this and add only their own config.
{ lib, config, ... }:
let
  defaults = import ./constants.nix;
  cfg = config.mine.system.theme;

  mkSize = which: default: lib.mkOption {
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
      desktop = mkSize "the desktop" defaults.fonts.sizes.desktop;
      popups = mkSize "popups" defaults.fonts.sizes.popups;
    };

    constants = lib.mkOption {
      type = lib.types.attrs;
      internal = true;
      readOnly = true;
      description = ''
        Fully resolved theme constants: constants.nix with the host's
        fontSizes overrides merged in. Passed to home-manager modules as
        the `themeConstants` module argument.
      '';
    };
  };

  config = {
    mine.system.theme.constants = defaults // {
      fonts = defaults.fonts // { sizes = cfg.fontSizes; };
    };

    # Unconditional: home-manager modules (alacritty, fish, firefox, ...)
    # read themeConstants whether or not system theming is enabled.
    #
    # Passed as a regular module arg rather than via extraSpecialArgs. A
    # specialArg is baked into the type of home-manager.users, so touching
    # any user's config would force the whole theme option tree; as a
    # _module.args it is only forced by the options that actually read it.
    # Nothing here needs it during `imports` resolution, which is the only
    # thing a specialArg would buy.
    home-manager.sharedModules = [
      { _module.args.themeConstants = cfg.constants; }
    ];
  };
}
