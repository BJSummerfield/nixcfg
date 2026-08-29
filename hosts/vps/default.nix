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
  sops.secrets.stalwart-api-key = {
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
      # 1 GB of RAM cannot compile photoform: it carries
      # passthru.cache = true and must arrive as a substituted closure.
      # caddy is stock nixpkgs and substitutes from cache.nixos.org.
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
        apiKeyFile = config.sops.secrets.stalwart-api-key.path;
      };
      # SNI edge on 443: caddy is the sole TLS authority for every name it
      # claims. The mail route terminates with its own Let's Encrypt cert
      # and proxies back to Stalwart's public listener over TLS — Stalwart
      # keeps its own ACME and certs, caddy is only the public presenter
      # (two LE accounts then hold certs for the same names; deliberate,
      # and different name sets, so they sit in different Let's Encrypt
      # duplicate-certificate buckets). The brianjs.com apex is unclaimed
      # by design (no A record).
      #
      # The upstream hop is verified, not skipped: Stalwart presents its
      # own LE cert for mx1.brianjs.com, so `tls_server_name` sends that
      # SNI over the veth and checks it against the public roots. This is
      # deliberately load-bearing — if Stalwart's ACME ever stops renewing
      # (it has no challenge path of its own while caddy owns 80 and
      # terminates 443), webmail breaks loudly here instead of mail TLS on
      # 25/465/993 failing silently a quarter later.
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
        routes.mail = {
          hostnames = [ "mx1.brianjs.com" ];
          target = "https://192.168.100.41:443";
          extraConfig = ''
            transport http {
              tls_server_name mx1.brianjs.com
            }
          '';
        };
      };
      # Booking site behind the edge, substituted from the cache: 1 GB of
      # RAM cannot compile it.
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
