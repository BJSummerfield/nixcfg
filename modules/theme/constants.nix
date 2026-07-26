# Single source of truth for theming values, consumed by modules directly.
# Palette is catppuccin-mocha as shipped by base16-schemes (captured from the
# stylix build before its removal — note base01/base03/base04 differ from the
# upstream catppuccin base16 port).
{
  colors = {
    base00 = "1e1e2e"; # default background
    base01 = "313244"; # lighter background (status bars)
    base02 = "45475a"; # selection background
    base03 = "6c7086"; # comments, invisibles
    base04 = "a6adc8"; # dark foreground
    base05 = "cdd6f4"; # default foreground
    base06 = "f5e0dc"; # light foreground
    base07 = "b4befe"; # light background
    base08 = "f38ba8"; # red
    base09 = "fab387"; # orange
    base0A = "f9e2af"; # yellow
    base0B = "a6e3a1"; # green
    base0C = "94e2d5"; # cyan
    base0D = "89b4fa"; # blue
    base0E = "cba6f7"; # magenta
    base0F = "f2cdcd"; # brown
  };

  fonts = {
    serif.name = "MonaspiceNe Nerd Font";
    sansSerif.name = "MonaspiceNe Nerd Font";
    monospace.name = "MonaspiceNe Nerd Font";
    emoji.name = "Noto Color Emoji";
    sizes = {
      applications = 12;
      terminal = 13;
      desktop = 12;
      popups = 11;
    };
  };

  cursor = {
    name = "Vanilla-DMZ";
    size = 32;
  };

  opacity = {
    terminal = 0.8;
    popups = 0.8;
  };
}
