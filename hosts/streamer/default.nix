{
  lib,
  pkgs,
  modulesPath,
  ...
}:
{
  imports = [
    "${modulesPath}/installer/sd-card/sd-image-aarch64.nix"
    ../../modules/nixos.nix
    ../../users/waktu.nix
  ];

  nixpkgs.hostPlatform = "aarch64-linux";

  mine.system.boot.mode = "extlinux";
  sdImage.compressImage = false;
  boot.supportedFilesystems.zfs = lib.mkForce false;

  zramSwap = {
    enable = true;
    memoryPercent = 50;
  };

  environment.systemPackages = with pkgs; [
    alsa-utils
    bottom
    git
    helix
  ];

  mine = {
    system = {
      hostName = "streamer";
      externalInterface = "end0";
      autoUpgrade.enable = true;
      fish.enable = true;
      openssh.inbound = {
        enable = true;
        openOnExternalInterface = true;
      };
      # sudo tailscale up
      tailscale = {
        enable = true;
        ssh = true;
      };
      streamer.enable = true;
    };
    users.waktu.authorizedKeys = [
      "onepassword"
      "redtruck"
      "t495"
      "mac"
    ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        helix.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
