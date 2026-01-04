{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
      ../../users
      ../../users/waktu.nix
      ../../users/dummy.nix
    ];

  environment.systemPackages = with pkgs; [
    git
    bottom
    helix
  ];

  mine = {
    system = {
      _1password.enable = true;
      hostName = "elitebook";
      shell.fish.enable = true;
      openssh.enable = true;
      tailscale.enable = true;
      niri.enable = true;
      docker.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password.enable = true;
        polkit-gnome.enable = true;
        git.enable = true;
        lazygit.enable = true;
        alacritty.enable = true;
        fuzzel.enable = true;
        firefox.enable = true;
      };
    };
    dummy = {
      mine.user = {
        git.enable = true;
        alacritty.enable = true;
        firefox.enable = true;
      };
    };
  };
}
