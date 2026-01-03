{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
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
      bottom.enable = true;
    };
    users = {
      waktu = { inherit pkgs; };
      dummy = { inherit pkgs; };
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
