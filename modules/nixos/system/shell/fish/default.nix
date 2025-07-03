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

    # programs.eza.enable = true;
    # programs.starship.enable = true;
    # programs.zoxide.enable = true;

    # programs.direnv = {
    #   enable = true;
    #   nix-direnv.enable = true;
    # };

    # programs.gh = {
    #   enable = true;
    #   settings = {
    #     git_protocol = "ssh";
    #   };
    # };

    # programs.git = {
    #   enable = true;
    #   userName = "BJSummerfield";
    #   userEmail = "brianjsummerfield@gmail.com";
    #   extraConfig.init.defaultBranch = "main";
    # };

    # programs.lazygit = {
    #   enable = true;
    #   settings = {
    #     gui = {
    #       language = "en";
    #     };
    #   };
    # };

    # add this to the shell init
    # direnv hook fish | source
    programs.fish = {
      enable = true;
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
