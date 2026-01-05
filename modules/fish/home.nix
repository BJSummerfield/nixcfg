{ lib, config, ... }:
{
  options.mine.user.fish.enable = lib.mkEnableOption "User Fish Config";

  config = lib.mkIf config.mine.user.fish.enable {
    programs.fish = {
      enable = true;
      interactiveShellInit = ''
        set fish_greeting # Disable greeting
        set -x NIX_PATH nixpkgs=channel:nixos-unstable
      '';
      loginShellInit = ''
        set fish_greeting # Disable greeting
      '';
    };
    catppuccin.fish.enable = true;
    stylix.targets.fish.enable = false;
  };
}
