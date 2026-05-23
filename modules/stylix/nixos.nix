{ inputs, pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.stylix;
  wallpaper = "mountain.jpg";
in
{
  imports = [ inputs.stylix.nixosModules.stylix ];
  options.mine.system.stylix.enable = mkEnableOption "Enable Stylix Theme";
  config = mkIf cfg.enable {
    stylix = {
      enable = true;
      autoEnable = false;
      polarity = "dark";
      opacity = {
        terminal = 0.8;
        popups = 0.8;
      };
      image = "${../wallpapers/${wallpaper}}";
      base16Scheme = "${pkgs.base16-schemes}/share/themes/catppuccin-mocha.yaml";
      cursor = {
        name = "Vanilla-DMZ";
        package = pkgs.vanilla-dmz;
        size = 32;
      };
      icons = {
        enable = true;
        package = pkgs.papirus-icon-theme;
        dark = "Papirus-Dark";
        light = "Papirus-Light";
      };
      fonts = {
        sizes = {
          applications = 12;
          terminal = 14;
          desktop = 12;
          popups = 10;
        };
        serif = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };
        sansSerif = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };
        monospace = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };
        emoji = {
          package = pkgs.noto-fonts-color-emoji;
          name = "Noto Color Emoji";
        };
      };
      targets = {
        font-packages.enable = true;
        fontconfig.enable = true;
        gtk.enable = true;
        gtksourceview.enable = true;
        nixos-icons.enable = true;
        qt.enable = true;
      };
    };

    home-manager.sharedModules = [
      {
        stylix.targets = {
          gtk.enable = true;
          qt.enable = true;
          fontconfig.enable = true;
        };
      }
    ];
  };
}
