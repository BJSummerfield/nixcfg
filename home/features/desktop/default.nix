{ pkgs, ... }: {
  imports = [
    ./hyprland
    ./fonts.nix
    ./battery.nix
  ];

  home.packages = with pkgs; [
  ];
}
