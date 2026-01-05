{ inputs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.catppuccin;
in
{
  imports = [
    inputs.catppuccin.homeModules.catppuccin
  ];

  options.mine.user.catppuccin.enable = mkEnableOption "Catppuccin flake theme styles";

  config = mkIf cfg.enable {
    catppuccin = {
      flavor = "mocha";
      accent = "blue";
      # fish.enable = mkIf theme-ables.system.shell.fish.enable true;
      # fuzzel.enable = mkIf theme-ables.desktop.fuzzel.enable true;
      # alacritty.enable = mkIf theme-ables.apps.alacritty.enable true;
      # ghostty.enable = mkIf theme-ables.apps.ghostty.enable true;
      # swaylock.enable = mkIf theme-ables.desktop.swaylock.enable true;
    };
  };
}
