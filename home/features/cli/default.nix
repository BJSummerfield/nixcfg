{ pkgs, ... }: {
  imports = [
    ./helix.nix
    ./ssh-1password.nix
  ];

  programs.zoxide.enable = true;
  programs.eza.enable = true;
  programs.starship.enable = true;

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

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

  programs.ghostty = {
    enable = true;
    settings = {
      font-family = "MonaspiceNe Nerd Font";
      window-decoration = false;
      theme = "catppuccin-mocha";
      background-opacity = 0.9;
      background-blur-radius = 15;
      font-size = 12;
    };
  };

  programs.gh = {
    enable = true;
    settings = {
      git_protocol = "ssh";
    };
  };

  programs.git = {
    enable = true;
    userName = "BJSummerfield";
    userEmail = "brianjsummerfield@gmail.com";
    extraConfig.init.defaultBranch = "main";
  };

  programs.lazygit = {
    enable = true;
    settings = {
      gui = {
        language = "en";
      };
    };
  };

  home.packages = with pkgs; [
    bottom
  ];
}
