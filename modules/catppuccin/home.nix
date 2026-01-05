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
    };
  };
}
