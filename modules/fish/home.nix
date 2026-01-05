{ lib, config, ... }:
{
  options.mine.user.shell.fish.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "User Fish Config";
  };

  config = lib.mkIf config.mine.user.shell.fish.enable {
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
