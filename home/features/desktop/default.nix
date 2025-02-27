{ pkgs, ... }: {
  imports = [
    ./hyprland.nix
    ./wayland.nix
    ./fonts.nix
  ];

  home.packages = with pkgs; [
  ];
}
