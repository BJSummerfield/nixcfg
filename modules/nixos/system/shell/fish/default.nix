{ lib, config, ... }:
let

  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.shell.fish;
in
{
  options.mine.system.shell.fish = {
    enable = mkEnableOption "fish";
  };

  config = mkIf cfg.enable {
    programs.fish = {
      enable = true;
      interactiveShellInit = ''
        set fish_greeting # Disable greeting
        set EDITOR hx
        set -x NIX_PATH nixpkgs=channel:nixos-unstable
        direnv hook fish | source
      '';
      loginShellInit = ''
        set fish_greeting # Disable greeting
      '';
      shellAliases = {
        ls = "eza";
        lg = "lazygit";
      };
    };
  };
}
