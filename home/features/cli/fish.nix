{ config
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.fish;
in
{
  options.features.cli.fish.enable = mkEnableOption "enable extended fish configuration";

  config = mkIf cfg.enable {
    programs.fish = {
      enable = true;
      # direnv hook fish | source
      interactiveShellInit = ''
        set fish_greeting # Disable greeting
        set EDITOR hx
        set -x NIX_PATH nixpkgs=channel:nixos-unstable
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
