{ pkgs, ... }: {
  imports = [
    ./hyprland.nix
    ./fonts.nix
  ];

  home.packages = with pkgs; [
  ];
}
