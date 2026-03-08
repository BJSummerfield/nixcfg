{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
    intel-gpu-tools
  ];

  environment.pathsToLink = [
    "/share/applications"
    "/share/xdg-desktop-portal"
  ];


  system.autoUpgrade = {
    enable = true;
    flake = "github:BJSummerfield/nixcfg";
    dates = "04:00";
    allowReboot = true;
    rebootWindow = {
      lower = "03:00";
      upper = "05:00";
    };
  };

  mine = {
    system = {
      hostName = "paynefield";
      externalInterface = "enp1s0";
      renderGroupGid = 303;
      fish.enable = true;
      tailscale.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        git.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
            toml.enable = true;
            yaml.enable = true;
          };
        };
        lazygit.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
