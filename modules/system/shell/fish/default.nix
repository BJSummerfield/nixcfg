{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.shell.fish;
  hm-cli-tools = config.mine.home-manager.cli-tools;
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
      '' + (mkIf hm-cli-tools.direnv.enable ''
        direnv hook fish | source
      '');
      loginShellInit = ''
        set fish_greeting # Disable greeting
      '';
      shellAliases = {
        ls = mkIf hm-cli-tools.eza.enable "eza";
        lg = mkIf hm-cli-tools.lazygit.enable "lazygit";
      };
    };
  };
}
