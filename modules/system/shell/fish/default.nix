{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.system.shell.fish;
  cli-tools = config.mine.cli-tools;
in
{
  options.mine.system.shell.fish = {
    enable = mkEnableOption "fish";
  };

  config = mkIf cfg.enable {

    # system level fish shell for auto-complete
    programs.fish.enable = true;

    home-manager.users.${user.name} = {
      programs.fish = {
        enable = true;
        interactiveShellInit = ''
          set fish_greeting # Disable greeting
          set -x NIX_PATH nixpkgs=channel:nixos-unstable
        '';
        loginShellInit = ''
          set fish_greeting # Disable greeting
        '';
        shellAliases = {
          lg = mkIf cli-tools.lazygit.enable "lazygit";
        };
      };
    };
  };
}
