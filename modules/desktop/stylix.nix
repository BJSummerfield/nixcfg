{ inputs, pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  stylixModule = inputs.stylix.homeModules.stylix;
  cfg = config.mine.desktop.theme.catppuccin;
  fonts = config.mine.system.fonts;
  items = config.mine;
in

{

  options.features.desktop.theme.enable = mkEnableOption "Enable theme config";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {

      imports = [
        stylixModule
      ];

      stylix = {
        enable = true;
        polarity = "dark";
        image = "${./wallpapers/${user.wallpaper}}";
        base16Scheme = "${pkgs.base16-schemes}/share/themes/catppuccin-mocha.yaml";
        autoEnable = true;
        targets = {
          firefox.enable = mkIf items.apps.firefox false;
          alacritty.enable = mkIf items.apps.alacritty false;
          helix.enable = mkIf items.cli-tools.helix false;
          fish.enable = mkIf items.system.shell.fish false;
          hyprlock.enable = mkIf items.desktop.hyprlock false;
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
            name = fonts.name;
          };

          sansSerif = {
            package = pkgs.nerd-fonts.monaspace;
            name = fonts.name;
          };

          monospace = {
            package = pkgs.nerd-fonts.monaspace;
            name = fonts.name;
          };

          emoji = {
            package = pkgs.noto-fonts-emoji;
            name = "Noto Color Emoji";
          };
        };
      };
    };
  };
}
