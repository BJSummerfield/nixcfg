{ lib, config, ... }:
{
  options.mine.user.fish.enable = lib.mkEnableOption "User Fish Config";

  config = lib.mkIf config.mine.user.fish.enable {
    xdg.configFile."fish/themes/Catppuccin Mocha.theme".source = ./catppuccin-mocha.theme;
    programs.fish = {
      enable = true;
      interactiveShellInit = ''
        set fish_greeting # Disable greeting
        set -x NIX_PATH nixpkgs=channel:nixos-unstable
        fish_config theme choose "Catppuccin Mocha"
      '';
      loginShellInit = ''
        set fish_greeting # Disable greeting
      '';
    };
    catppuccin.fish.enable = false;
    stylix.targets.fish.enable = false;
  };
}
