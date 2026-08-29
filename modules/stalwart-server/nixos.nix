# Minimal local config — only boot-critical keys; everything else is
# database-managed via web UI (certs, domains, accounts, DKIM, spam).
#
# Bring-up:
#   sudo nixos-container root-login stalwart
#   tailscale up --hostname=stalwart --advertise-tags=tag:solo-node --accept-dns=false
#   tailscale serve --bg --https=8443 8080
#     (serve listens on 443 by default and collides with Stalwart's public
#      https/JMAP/CalDAV listener; admin UI:
#      https://stalwart.mist-gamma.ts.net:8443)
#
# First login: admin / the inline fallback password below — CHANGE it in
# the UI. Let's Encrypt is configured there too; the cert won't issue until
# DNS points at the box.

{
  lib,
  config,
  ...
}:
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
  };

  config = lib.mkIf cfg.enable {
    system.activationScripts.stalwart-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
      mkdir -p /var/lib/tailscale-stalwart
      chmod 700 /var/lib/tailscale-stalwart
    '';

    networking.firewall.allowedTCPPorts = [
      25
      465
      993
    ]
    ++ lib.optional (!config.mine.system.caddy.enable) 443;

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-stalwart" ];
      externalInterface = config.mine.system.externalInterface;
      # When the caddy edge owns host 443, its mx1 route is the only path
      # to Stalwart's public listener (caddy terminates TLS, then
      # reverse-proxies it over TLS); the mail-port forwards stay
      # unconditional.
      forwardPorts = [
        {
          sourcePort = 25;
          destination = "192.168.100.41:25";
          proto = "tcp";
        }
        {
          sourcePort = 465;
          destination = "192.168.100.41:465";
          proto = "tcp";
        }
        {
          sourcePort = 993;
          destination = "192.168.100.41:993";
          proto = "tcp";
        }
      ]
      ++ lib.optionals (!config.mine.system.caddy.enable) [
        {
          sourcePort = 443;
          destination = "192.168.100.41:443";
          proto = "tcp";
        }
      ];
    };

    # This backup carries ALL your DB-managed config (ACME, domains, accounts,
    # aliases) -- it is the source of truth for everything not in this file.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "stalwart" ];
    };

    containers.stalwart = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.40";
      localAddress = "192.168.100.41";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
        # Persistent state -- MUST be /var/lib/stalwart-mail to match the
        # module's StateDirectory (where its built-in 'db' store lives).
        "/var/lib/stalwart-mail" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-stalwart";
          isReadOnly = false;
        };
        "/run/stalwart/admin-pw" = {
          hostPath = cfg.adminPasswordFile;
          isReadOnly = true;
        };
      };

      config =
        {
          config,
          pkgs,
          lib,
          ...
        }:
        {
          systemd.services.stalwart.serviceConfig.LoadCredential = [
            "admin-pw:/run/stalwart/admin-pw"
          ];

          services.tailscale.enable = true;

          services.stalwart = {
            enable = true;
            package = pkgs.stalwart_0_15;
            openFirewall = false;
            stateVersion = "24.11";
            settings = {
              # MINIMAL LOCAL CONFIG
              # Only boot-critical keys are pinned local (read-only file): the
              # stable settings the server needs BEFORE it can read the
              # database. Narrow patterns only - no broad pins (no acme.*, no
              # resolver.*) so a future upgrade adding sub-keys there won't
              # fight us.
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
                # A bootstrap hostname so the server can start before the
                # production one is set in the web UI; it then lives in the DB.
                hostname = "mx1.brianjs.com";
                tls = {
                  enable = true;
                  implicit = true;
                };
                listener = {
                  smtp = {
                    protocol = "smtp";
                    bind = "[::]:25";
                  };
                  submissions = {
                    protocol = "smtp";
                    bind = "[::]:465";
                    tls.implicit = true;
                  };
                  imaps = {
                    protocol = "imap";
                    bind = "[::]:993";
                    tls.implicit = true;
                  };
                  https = {
                    protocol = "http";
                    bind = "192.168.100.41:443";
                    tls.implicit = true;
                  };
                  # Admin UI on localhost only; reached via Tailscale serve :8443.
                  management = {
                    protocol = "http";
                    bind = [ "127.0.0.1:8080" ];
                  };
                };
              };

              # Built-in 'db' RocksDB store at /var/lib/stalwart-mail/db;
              # boot-critical - the server must know its store before
              # reading DB config.
              storage = {
                data = "db";
                blob = "db";
                fts = "db";
                lookup = "db";
                directory = "internal";
              };
              directory.internal = {
                type = "internal";
                store = "db";
              };

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
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              allowedTCPPorts = [
                25
                465
                993
                443
              ];
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
            RestrictAddressFamilies = lib.mkForce [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
              "AF_NETLINK"
            ];
          };

          system.stateVersion = "24.11";
        };
    };
  };
}
