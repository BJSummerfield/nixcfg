{
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
  boot.supportedFilesystems.zfs = false;

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
      externalInterface = "wlan0";
      autoUpgrade.enable = true;
      fish.enable = true;
      # sudo tailscale up
      remoteAccess = {
        enable = true;
        lanAccess = true;
      };
      streamer = {
        enable = true;
        usbId = "2972:0099";
      };
    };
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
