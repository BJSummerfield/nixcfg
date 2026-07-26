{ pkgs, ... }:
let
  theme = import ./constants.nix;
  fontName = theme.fonts.sansSerif.name;
  appSize = theme.fonts.sizes.applications;
in
{
  home.pointerCursor = {
    enable = true;
    inherit (theme.cursor) name size;
    package = pkgs.vanilla-dmz;
    gtk.enable = true;
    x11.enable = true;
  };

  gtk = {
    enable = true;
    font = {
      name = fontName;
      size = appSize;
      package = pkgs.nerd-fonts.monaspace;
    };
    theme = {
      name = "adw-gtk3";
      package = pkgs.adw-gtk3;
    };
    iconTheme = {
      name = "Papirus-Dark";
      package = pkgs.papirus-icon-theme;
    };
    gtk4.extraConfig.gtk-theme-name = "adw-gtk3";
  };

  # Palette-derived @define-color CSS (vendored from the stylix gtk target);
  # regenerate by hand if constants.nix colors change.
  xdg.configFile."gtk-3.0/gtk.css".source = ./gtk.css;
  xdg.configFile."gtk-4.0/gtk.css".source = ./gtk.css;

  qt = {
    enable = true;
    platformTheme.name = "qtct";
    style.name = "kvantum";
    qt5ctSettings = {
      Appearance = {
        custom_palette = true;
        icon_theme = "Papirus-Dark";
        standard_dialogs = "default";
        style = "kvantum";
      };
      Fonts = {
        fixed = "\"${theme.fonts.monospace.name},${toString appSize}\"";
        general = "\"${fontName},${toString appSize}\"";
      };
    };
    qt6ctSettings = {
      Appearance = {
        custom_palette = true;
        icon_theme = "Papirus-Dark";
        standard_dialogs = "default";
        style = "kvantum";
      };
      Fonts = {
        fixed = "\"${theme.fonts.monospace.name},${toString appSize}\"";
        general = "\"${fontName},${toString appSize}\"";
      };
    };
  };

  # Kvantum theme vendored from the stylix qt target (colors baked from
  # constants.nix palette).
  xdg.configFile."Kvantum/Base16Kvantum" = {
    source = ./kvantum/Base16Kvantum;
    # Per-file links (not one dir symlink) so activation can take over the
    # directory the previous generation already managed recursively.
    recursive = true;
  };
  xdg.configFile."Kvantum/kvantum.kvconfig".text = ''
    [General]
    theme=Base16Kvantum
  '';

  dconf.settings."org/gnome/desktop/interface" = {
    color-scheme = "prefer-dark";
    font-name = "${fontName} ${toString appSize}";
    # double space preserved from the stylix template we migrated off of
    document-font-name = "${fontName}  ${toString (appSize - 1)}";
    monospace-font-name = "${theme.fonts.monospace.name} ${toString appSize}";
  };
}
