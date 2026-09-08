{
  pkgs,
  config,
  modulesPath,
  ...
}:
{
  imports = [
    ./disko.nix
    ../../modules/nixos.nix
    ../../users/waktu.nix
    "${modulesPath}/profiles/qemu-guest.nix"
  ];

  nixpkgs.hostPlatform = "x86_64-linux";

  mine.system.boot.mode = "grub-bios";

  zramSwap = {
    enable = true;
    memoryPercent = 25;
  };

  environment.pathsToLink = [
    "/share/applications"
    "/share/xdg-desktop-portal"
  ];
  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  sops.secrets.stalwart-admin-pw = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
  sops.secrets.restic-b2-env = {
    sopsFile = ../../secrets/services/restic-b2.yaml;
    mode = "0400";
  };
  sops.secrets.restic-repo-password = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };

  mine = {
    system = {
      hostName = "vps";
      autoUpgrade.enable = true;
      privateCache.enable = true;
      wheelNeedsPassword = false;
      externalInterface = "enp1s0";
      fish.enable = true;
      openssh.inbound = {
        enable = true;
        openOnExternalInterface = true;
      };
      stalwart-server = {
        enable = true;
        adminPasswordFile = config.sops.secrets.stalwart-admin-pw.path;
      };
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
      };
      photoform = {
        enable = true;
        sopsFile = ../../secrets/hosts/vps.yaml;
      };
      # sudo tailscale up --advertise-tags=tag:vps --accept-dns=false
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-server = {
        enable = true;
        publicAccess = true;
        tailscaleAccess = false;
      };
    };
    backups = {
      enable = true;
      repository = "s3:s3.us-east-005.backblazeb2.com/spacefunk-nix-backups/vps";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
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
