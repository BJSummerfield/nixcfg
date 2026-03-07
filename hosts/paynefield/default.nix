{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../users/waktu.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
    intel-gpu-tools
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
      externalInterface = "wlp0s20f3";
      renderGroupGid = 303;
      fish.enable = true;
      tailscale.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        alacritty.enable = true;
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
