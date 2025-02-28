{ pkgs, ... }: {
  imports = [
    ./hyprland
    ./fonts.nix
  ];

  home.packages = with pkgs; [
  ];
}
