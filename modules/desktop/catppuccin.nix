{ inputs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  catppuccinModule = inputs.catppuccin.homeModules.catppuccin;
  cfg = config.mine.desktop.theme.catppuccin;
  theme-ables = config.mine;
in
{

  options.mine.desktop.theme.catppuccin.enable = mkEnableOption "Catppuccin flake theme styles";
  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {

      imports = [
        catppuccinModule
      ];

      catppuccin = {
        flavor = "mocha";
        accent = "blue";
        fish.enable = mkIf theme-ables.system.shell.fish.enable true;
        fuzzel.enable = mkIf theme-ables.desktop.fuzzel.enable true;
        alacritty.enable = mkIf theme-ables.apps.alacritty.enable true;
      };
    };
  };
}
