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

  home.packages = with pkgs; [
    bottom
  ];
}
