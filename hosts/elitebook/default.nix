{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
      ../../modules/users/waktu.nix
      ../../modules/users/dummy.nix
    ];

  environment.systemPackages = with pkgs; [
    git
    bottom
    helix
  ];

  mine = {
    system = {
      hostName = "elitebook";
      shell.fish.enable = true;
      openssh.enable = true;
      tailscale.enable = true;
      git.enable = true;
      lazygit.enable = true;
    };
  };

  home-manager.users = {
    waktu = {
      mine.user = {
        git.enable = true;
        lazygit.enable = true;
      };
    };
    dummy = {
      mine.user = {
        git.enable = true;
      };
    };
  };
}
