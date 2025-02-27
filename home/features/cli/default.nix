{ pkgs, ... }: {
  imports = [
    ./fish.nix
    ./helix.nix
    ./git.nix
    ./ssh-1password.nix
  ];

  programs.zoxide.enable = true;
  programs.eza.enable = true;
  programs.starship.enable = true;
  programs.ghostty = {
    enable = true;
    settings = {
      font-family = "MonaspiceNe Nerd Font Mono";
      window-decoration = false;
      theme = "catppuccin-mocha";
      background-opacity = 0.9;
      background-blur-radius = 15;
      font-size = 12;
    };
  };

  home.packages = with pkgs; [
    bottom
  ];
}
