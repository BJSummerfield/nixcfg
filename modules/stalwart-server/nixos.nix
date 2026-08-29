# Stalwart mail server container.
# Minimal local config — only boot-critical keys. Everything else is
# database-managed via web UI (certs, domains, accounts, DKIM, spam).
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

{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.stalwart-server;
  hostStateDir = "/var/lib/stalwart-data";
  certDir = "/var/lib/stalwart-certs";
  # The hostname Stalwart presents on every listener, and the name caddy
  # obtains the shared certificate for.
  mailHostname = "mx1.brianjs.com";
  # Static so the host can chgrp published files to a group the container
  # resolves to the same number. stalwart-mail's uid is allocated
  # dynamically and changing it would mean chowning a live mail store.
  certGid = 700;
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
    apiKeyFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to a Stalwart API key with the "Refresh system settings"
        permission, used to reload TLS certificates after caddy renews them.
        Created in the admin UI; Stalwart's API keys are DB-managed and
        cannot be declared here.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    system.activationScripts.stalwart-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
      mkdir -p /var/lib/tailscale-stalwart
      chmod 700 /var/lib/tailscale-stalwart
      # systemd-nspawn refuses to start when a bind mount's host source is
      # missing, and the publish unit that creates this one only runs after
      # caddy -- too late for the container's first start. Ownership is left
      # to that unit's install -d, which sets it on every run.
      mkdir -p ${certDir}
      chmod 750 ${certDir}
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

    # Caddy is the sole issuer for the mail hostname: Stalwart's own
    # TLS-ALPN-01 cannot complete while caddy terminates :443, and its
    # certificate still serves 25/465/993, which bypass caddy entirely.
    mine.system.caddy.certExports = lib.mkIf config.mine.system.caddy.enable {
      stalwart = {
        hostname = mailHostname;
        destination = certDir;
        owner = "root";
        group = "stalwart-certs";
        # Reload in-place rather than restarting: this runs on every renewal
        # and a restart drops live IMAP and SMTP connections. The management
        # listener is plain HTTP on the container's loopback, so rotating TLS
        # never depends on a TLS connection secured by the certificate being
        # replaced.
        postPublish = ''
          if ! ${pkgs.nixos-container}/bin/nixos-container run stalwart -- \
              ${pkgs.curl}/bin/curl --fail --silent --show-error \
                -H "Authorization: Bearer $(cat ${cfg.apiKeyFile})" \
                http://127.0.0.1:8080/api/reload/certificate; then
            echo "certificate reload failed; restarting stalwart" >&2
            systemctl restart container@stalwart
          fi

          # Verify rather than assume. A reload that silently did not take
          # leaves Stalwart serving the old certificate from memory until it
          # expires -- the exact silent failure this whole change exists to
          # remove. Source address is the veth gateway, which must stay
          # allow-listed in Stalwart's security settings.
          served=$(openssl s_client -connect 192.168.100.41:443 \
            -servername ${mailHostname} </dev/null 2>/dev/null \
            | openssl x509 -noout -fingerprint -sha256)
          ondisk=$(openssl x509 -in ${certDir}/cert.pem -noout -fingerprint -sha256)
          if [ "$served" != "$ondisk" ]; then
            echo "stalwart is not serving the published certificate" >&2
            echo "  served: $served" >&2
            echo "  ondisk: $ondisk" >&2
            exit 1
          fi
        '';
      };
    };

    users.groups.stalwart-certs.gid = certGid;

    containers.stalwart = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.40";
      localAddress = "192.168.100.41";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        } # tun for Tailscale
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
        # Read-only: caddy renews, the host publishes, Stalwart only reads.
        "${certDir}" = {
          hostPath = certDir;
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

          # Matches the host's gid so the bind-mounted 0640 files are readable
          # without knowing stalwart-mail's dynamically-allocated uid.
          users.groups.stalwart-certs.gid = certGid;
          users.users.stalwart-mail.extraGroups = [ "stalwart-certs" ];

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
