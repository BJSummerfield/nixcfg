{
  pkgs,
  lib,
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

  # BIOS boot VM — GRUB instead of the default systemd-boot.
  mine.system.boot.mode = "grub-bios";

  # The disko layout has no swap partition, so a memory spike in Stalwart would
  # go straight to the OOM killer. Compressed RAM instead of a disk partition -
  # a VPS root disk is small and the write amplification isn't worth it.
  #
  # 25% not redtruck's 50%: this box has ~1G, and the zram device costs real
  # RAM as it fills. 256M of swap for roughly 100M resident at zstd ratios.
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
      # 1 GB of RAM cannot compile caddy-with-l4 or photoform: both carry
      # passthru.cache = true and must arrive as substituted closures.
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
        # hostname, domains, ACME, and all mail config are set in the web UI
        # (database-managed). Only the box + break-glass admin here; backup
        # is the shared host job (mine.backups, below).
        adminPasswordFile = config.sops.secrets.stalwart-admin-pw.path;
      };
      # SNI edge on 443. Fallback-only until photoform lands: every
      # connection behaves exactly like the old DNAT into Stalwart.
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
        fallback = "192.168.100.41:443";
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
