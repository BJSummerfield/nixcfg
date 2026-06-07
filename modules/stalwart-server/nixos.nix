# Stalwart all-in-one mail server in a NixOS (nspawn) container.
#
# DESIGN: minimal LOCAL config. Only the boot-critical keys live in this
# read-only Nix store file -- store location, listeners, and the bootstrap
# admin. EVERYTHING ELSE (ACME/TLS, domains, accounts, aliases, spam, sender
# policy, DKIM/DMARC) is DATABASE-managed via the web UI and persists in
# /var/lib/stalwart-mail (backed up by restic). This minimizes the chance of
# fighting the server when upstream changes config-key layouts on upgrade.
#
# Bring-up:
#   sudo nixos-container root-login stalwart
#   tailscale up --hostname=stalwart --advertise-tags=tag:solo-node --accept-dns=false
#   tailscale serve --bg --https=8443 8080
#     (serve listens on 443 by default and collides with Stalwart's public
#      https/JMAP/CalDAV listener -- use 8443. Admin UI:
#      https://stalwart.mist-gamma.ts.net:8443)
#
# First login + config (all in the web UI):
#   1. Log in: admin / the inline fallback password below. CHANGE it in the UI.
#   2. Settings -> TLS/ACME: configure Let's Encrypt (directory, contact,
#      domains = brianjs.com + mx1.brianjs.com). The cert won't issue until DNS
#      points at the box.
#   3. Settings -> Server/Hostname: set hostname to mx1.brianjs.com.
#   4. Settings -> Authentication: set must-match-sender = true (multi-user safe).
#   5. Domains: create brianjs.com -> read the generated DNS records (DKIM etc.)
#      and add them at Namecheap.
#   6. Accounts: create your real mailbox + aliases.

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.stalwart-server;
  hostStateDir = "/var/lib/stalwart-data";
in
{
  options.mine.system.stalwart-server = {
    enable = lib.mkEnableOption "Enable Stalwart all-in-one mail server container";
    adminPasswordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        spot        Host path to the decrypted fallback-admin secret (e.g.
                config.sops.secrets.stalwart-admin-pw.path). Owned by stalwartUid,
                bind-mounted read-only into the container. Store an argon2 hash; log in
                with the plaintext.
      '';
    };

    backup = {
      b2EnvFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Host path to a restic B2 credentials env file containing:
            B2_ACCOUNT_ID=<keyID>
            B2_ACCOUNT_KEY=<applicationKey>
        '';
      };
      repoPasswordFile = lib.mkOption {
        type = lib.types.path;
        description = "Host path to the restic repository password.";
      };
      repository = lib.mkOption {
        type = lib.types.str;
        example = "b2:spacefunk-mail-backups:stalwart";
        description = "restic repository URL (B2 bucket + path).";
      };
      schedule = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ "00:00" "12:00" ];
        description = "systemd OnCalendar times for the twice-daily backup.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    system.activationScripts.stalwart-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
      mkdir -p /var/lib/tailscale-stalwart
      chmod 700 /var/lib/tailscale-stalwart
    '';

    networking.firewall.allowedTCPPorts = [ 25 465 993 443 ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-stalwart" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        { sourcePort = 25; destination = "192.168.100.41:25"; proto = "tcp"; }
        { sourcePort = 465; destination = "192.168.100.41:465"; proto = "tcp"; }
        { sourcePort = 993; destination = "192.168.100.41:993"; proto = "tcp"; }
        { sourcePort = 443; destination = "192.168.100.41:443"; proto = "tcp"; }
      ];
    };

    # restic runs HOST-side, against the bind-mount source. The container has no
    # access to the B2 key, so a mail-service compromise cannot touch backups.
    # This backup carries ALL your DB-managed config (ACME, domains, accounts,
    # aliases) -- it is the source of truth for everything not in this file.
    services.restic.backups.stalwart = {
      repository = cfg.backup.repository;
      passwordFile = cfg.backup.repoPasswordFile;
      environmentFile = cfg.backup.b2EnvFile;
      paths = [ hostStateDir ];
      timerConfig = {
        OnCalendar = cfg.backup.schedule;
        Persistent = true;
      };
      backupPrepareCommand = ''
        ${pkgs.nixos-container}/bin/nixos-container stop stalwart || true
      '';
      backupCleanupCommand = ''
        ${pkgs.nixos-container}/bin/nixos-container start stalwart || true
      '';
      pruneOpts = [
        "--keep-daily 30"
        "--keep-weekly 12"
        "--keep-monthly 12"
      ];
    };

    containers.stalwart = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.40";
      localAddress = "192.168.100.41";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; } # tun for Tailscale
      ];

      bindMounts = {
        # Persistent state -- MUST be /var/lib/stalwart-mail to match the
        # module's StateDirectory (where its built-in 'db' store lives).
        "/var/lib/stalwart-mail" = { hostPath = hostStateDir; isReadOnly = false; };
        "/dev/net/tun" = { hostPath = "/dev/net/tun"; isReadOnly = false; };
        "/var/lib/tailscale" = { hostPath = "/var/lib/tailscale-stalwart"; isReadOnly = false; };
        "/run/stalwart/admin-pw" = { hostPath = cfg.adminPasswordFile; isReadOnly = true; };
      };

      config = { config, pkgs, lib, ... }: {

        systemd.services.stalwart.serviceConfig.LoadCredential = [
          "admin-pw:/run/stalwart/admin-pw"
        ];

        services.tailscale.enable = true;

        services.stalwart = {
          enable = true;
          openFirewall = false;
          stateVersion = "24.11";
          settings = {
            # ---- MINIMAL LOCAL CONFIG ----
            # Only boot-critical keys are pinned local (read-only file). These
            # are the stable settings the server needs BEFORE it can read the
            # database: where the store is, what to listen on, and how to log in.
            # Everything else is DB-managed in the web UI. Narrow patterns only;
            # we deliberately avoid broad pins (no acme.*, no resolver.*) so a
            # future upgrade adding sub-keys there won't fight us.
            config.local-keys = [
              "store.*"
              "storage.data"
              "storage.blob"
              "storage.fts"
              "storage.lookup"
              "storage.directory"
              "directory.*"
              "server.listener.*"
              "server.hostname"
              "tracer.*"
              "authentication.fallback-admin.*"
            ];

            server = {
              # A bootstrap hostname so the server can start before you set the
              # real one in the UI. Set the production hostname (mx1.brianjs.com)
              # in the web UI; it then lives in the DB.
              hostname = "mx1.brianjs.com";
              tls = { enable = true; implicit = true; };
              listener = {
                smtp = { protocol = "smtp"; bind = "[::]:25"; };
                submissions = { protocol = "smtp"; bind = "[::]:465"; tls.implicit = true; };
                imaps = { protocol = "imap"; bind = "[::]:993"; tls.implicit = true; };
                https = { protocol = "http"; bind = "[::]:443"; tls.implicit = true; };
                # Admin UI on localhost only; reached via Tailscale serve :8443.
                management = { protocol = "http"; bind = [ "127.0.0.1:8080" ]; };
              };
            };

            # Store: use the module's built-in 'db' RocksDB store at
            # /var/lib/stalwart-mail/db. These role assignments are boot-critical
            # (the server must know its store before reading DB config).
            storage = {
              data = "db";
              blob = "db";
              fts = "db";
              lookup = "db";
              directory = "internal";
            };
            directory.internal = { type = "internal"; store = "db"; };

            # Break-glass admin. Secret read from the bind-mounted sops file,
            # owned by stalwartUid (= the stalwart-mail service UID), mode 0400.
            # Store an argon2 hash in the sops secret; log in with the plaintext.
            # Local key (immutable via UI by design) -- change via sops + rebuild.
            authentication.fallback-admin = {
              user = "admin";
              secret = "%{file:/run/credentials/stalwart.service/admin-pw}%";
            };

            # NOTE: ACME/TLS, must-match-sender, spam, domains, accounts, and
            # aliases are intentionally NOT set here -- configure them in the web
            # UI so they live in the (writable, backed-up) database.
          };
        };

        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            allowedTCPPorts = [ 25 465 993 443 ];
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        systemd.services.stalwart.serviceConfig = {
          ProtectHome = lib.mkForce true;
          PrivateTmp = lib.mkForce true;
          ProtectControlGroups = lib.mkForce true;
          ProtectKernelTunables = lib.mkForce true;
          NoNewPrivileges = lib.mkForce true;
          RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
