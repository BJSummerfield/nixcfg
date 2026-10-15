{ pkgs, config, ... }:
{
  imports = [
    ../../modules/nixos.nix
    ../../users/waktu.nix
  ];

  nixpkgs.hostPlatform = "x86_64-linux";
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = true;
  boot.initrd.availableKernelModules = [
    "xhci_pci"
    "ahci"
    "nvme"
    "usbhid"
    "usb_storage"
    "sd_mod"
  ];
  boot.kernelModules = [ "kvm-intel" ];

  fileSystems."/" = {
    device = "/dev/disk/by-uuid/a377bf35-5dce-4665-aa91-38d02916c3ac";
    fsType = "ext4";
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/062A-92E8";
    fsType = "vfat";
    options = [
      "fmask=0077"
      "dmask=0077"
    ];
  };
  swapDevices = [ { device = "/dev/disk/by-uuid/c3e85ef5-7f56-460c-aba9-99cc1cc6ec47"; } ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
    intel-gpu-tools
  ];

  sops.secrets.restic-b2-env = {
    sopsFile = ../../secrets/services/restic-b2.yaml;
    mode = "0400";
  };
  sops.secrets.restic-repo-password = {
    sopsFile = ../../secrets/hosts/paynefield.yaml;
    mode = "0400";
  };
  sops.secrets.keybase-webhook-url = {
    sopsFile = ../../secrets/hosts/paynefield.yaml;
    mode = "0400";
  };

  environment.pathsToLink = [
    "/share/applications"
    "/share/xdg-desktop-portal"
  ];

  mine = {
    system = {
      hostName = "paynefield";
      externalInterface = "enp1s0";
      renderGroupGid = 303;
      autoUpgrade.enable = true;
      dns-server.enable = true;
      fish.enable = true;
      remoteAccess = {
        enable = true;
        lanAccess = true;
      };
      jellyfin-server.enable = true;
      immich-server.enable = true;
      valheim-server = {
        enable = true;
        notifyUrlFile = config.sops.secrets.keybase-webhook-url.path;
        worldName = "janky";
        password = "beefcake";
        modifiers = {
          resources = "most";
          deathpenalty = "casual";
          raids = "muchless";
          portals = "casual";
        };
      };
    };
    backups = {
      enable = true;
      repository = "s3:s3.us-east-005.backblazeb2.com/spacefunk-nix-backups/paynefield";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
      notifyUrlFile = config.sops.secrets.keybase-webhook-url.path;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
            toml.enable = true;
            yaml.enable = true;
          };
        };
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
