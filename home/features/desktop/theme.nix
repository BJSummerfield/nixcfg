{ pkgs, config, lib, ... }:
with lib; let
  cfg = config.features.desktop.theme;
  stylixModule = inputs.stylix.homeManagerModules.stylix;
  catppuccinModule = inputs.catppuccin.homeManagerModules.catppuccin;
in
{
  imports = [
    stylixModule
    catppuccinModule
  ];
  options.features.desktop.theme.enable = mkEnableOption "Enable theme config";
  config = mkIf cfg.enable {

    catppuccin = {
      flavor = "mocha";
      fish.enable = true;
    };

    stylix = {
      enable = true;
      polarity = "dark";
      image = ./wallpapers/mountain.jpg;
      base16Scheme = "${pkgs.base16-schemes}/share/themes/catppuccin-mocha.yaml";
      autoEnable = true;
      targets = {
        ghostty.enable = false;
        helix.enable = false;
        fish.enable = false;
      };

      cursor = {
        name = "Vanilla-DMZ";
        package = pkgs.vanilla-dmz;
        size = 32;
      };

      iconTheme = {
        enable = true;
        package = pkgs.papirus-icon-theme;
        dark = "Papirus-Dark";
        light = "Papirus-Light";
      };
      fonts = {
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
          package = pkgs.noto-fonts-emoji;
          name = "Noto Color Emoji";
        };
      };
    };
  };
}
