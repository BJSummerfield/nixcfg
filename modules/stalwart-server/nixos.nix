# Once the container is running log into it with
# sudo nixos-container root-login stalwart
# tailscale up --hostname=stalwart --advertise-tags=tag:solo-node --accept-dns=false
# tailscale serve --bg 8080
#
# First-run bootstrap (after DNS + Hetzner port-25 unblock are in place):
#   stalwart-cli --url https://stalwart.mist-gamma.ts.net domain create brianjs.com
#   ...then create your real mail account in the web admin; its password is
#   stored hashed in the persistent store and SURVIVES rebuilds (internal dir).
#   The sops secret here is only the fallback-admin bootstrap password.


{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.stalwart-server;
  adminPwInContainer = "/run/stalwart/admin-pw";
  hostStateDir = "/var/lib/stalwart-data";
in
{
  options.mine.system.stalwart-server = {
    enable = lib.mkEnableOption "Enable Stalwart all-in-one mail server container";

    hostname = lib.mkOption {
      type = lib.types.str;
      example = "mx1.example.org";
      description = ''
        The mail server hostname Stalwart announces (HELO/EHLO, cert CN). Your
        VPS PTR (reverse DNS) record at Hetzner MUST resolve to this name, and
        your SPF record must authorise this host's public IP. This is the single
        most important value for outbound deliverability.
      '';
    };

    domains = lib.mkOption {
      type = lib.types.nonEmptyListOf lib.types.str;
      example = [ "example.org" "example.net" ];
      description = ''
        Mail domains handled by this server. The first entry is treated as the
        primary (used for default lookups). ACME requests certs for every domain
        plus the hostname. You still create each domain object and its DKIM/MX/
        DMARC records per domain (via the admin UI / `domain create` + DNS).
      '';
    };

    acmeContact = lib.mkOption {
      type = lib.types.str;
      example = "you@example.org";
      description = "Contact email used for ACME (Let's Encrypt) registration.";
    };

    adminPasswordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to the decrypted fallback-admin bootstrap password
        (e.g. config.sops.secrets.stalwart-admin-pw.path). Bind-mounted
        read-only into the container.
      '';
    };

    backup = {
      b2EnvFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Host path to an env file containing the Backblaze B2 credentials for
          restic, e.g. config.sops.secrets.restic-b2-env.path. Must define:
            B2_ACCOUNT_ID=<keyID>
            B2_ACCOUNT_KEY=<applicationKey>
        '';
      };

      repoPasswordFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Host path to the restic repository password
          (e.g. config.sops.secrets.restic-repo-pw.path).
        '';
      };

      repository = lib.mkOption {
        type = lib.types.str;
        example = "b2:my-mail-backups:vps/stalwart";
        description = "restic repository URL (Backblaze B2 bucket + path).";
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

    services.restic.backups.stalwart = {
      repository = cfg.backup.repository;
      passwordFile = cfg.backup.repoPasswordFile;
      environmentFile = cfg.backup.b2EnvFile;

      paths = [ hostStateDir ];
      timerConfig = {
        OnCalendar = cfg.backup.schedule;
        Persistent = true;
      };

      # Consistency: pause the mail server for the few seconds the snapshot
      # takes so we never capture a torn write.
      backupPrepareCommand = ''
        ${pkgs.nixos-container}/bin/nixos-container stop stalwart || true
      '';
      backupCleanupCommand = ''
        ${pkgs.nixos-container}/bin/nixos-container start stalwart || true
      '';

      pruneOpts = [
        # Retention sits ABOVE the bucket's 60-day object lock so auto-prune
        # never tries to delete a still-locked object (90 > 60, ~30-day margin).
        # Auto-prune is safe to leave on: it runs HOST-side with a delete-capable
        # key the container never sees, and only ever removes 90+ day-old data
        # whose object lock expired ~30 days earlier.
        "--keep-daily 90"
        "--keep-weekly 16"
        "--keep-monthly 12"
      ];
    };

    containers.stalwart = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.40";
      localAddress = "192.168.100.41";

      # tun needed for the Tailscale node (admin UI access)
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        # Persistent state: RocksDB store + blobs + ACME cert cache.
        # Target MUST match the module's StateDirectory (stalwart-mail),
        # which is where the module's built-in 'db' store lives.
        "/var/lib/stalwart-mail" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };

        # Decrypted sops secret, mapped read-only from the host.
        "${adminPwInContainer}" = {
          hostPath = cfg.adminPasswordFile;
          isReadOnly = true;
        };

        # tun device for Tailscale
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };

        # Persist the Tailscale node identity (admin-UI access)
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-stalwart";
          isReadOnly = false;
        };
      };

      config = { config, pkgs, lib, ... }: {

        services.tailscale.enable = true;

        services.stalwart = {
          enable = true;
          # We open ports via the container firewall explicitly below rather
          # than openFirewall, so the admin port stays internal.
          openFirewall = false;
          stateVersion = "24.11";
          settings = {
            # The spam filter rules + webadmin UI ship INSIDE the stalwart
            # package but the NixOS module does not auto-wire them. Without
            # spam-filter.resource, startup fails at "Failed to load spam
            # filter model" (which then aborts the DB migration). Point both
            # at the files shipped in the package.
            spam-filter.resource =
              "file://${config.services.stalwart.package}/etc/stalwart/spamfilter.toml";
            webadmin.resource =
              "file://${config.services.stalwart.package.webadmin}/webadmin.zip";

            server = {
              hostname = cfg.hostname;
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
                  bind = "[::]:465";
                  protocol = "smtp";
                  tls.implicit = true;
                };
                imaps = {
                  bind = "[::]:993";
                  protocol = "imap";
                  tls.implicit = true;
                };
                https = {
                  bind = "[::]:443";
                  protocol = "http";
                  tls.implicit = true;
                  url = "https://${cfg.hostname}";
                };
                # Admin/management: bound to localhost inside the container,
                # reached via `tailscale serve 8080`. Never NAT-forwarded.
                management = {
                  bind = [ "127.0.0.1:8080" ];
                  protocol = "http";
                };
              };
            };

            lookup.default = {
              hostname = cfg.hostname;
              # primary domain = first in the list
              domain = builtins.head cfg.domains;
            };

            # ACME via Let's Encrypt. HTTP-01 over the public 443 listener works;
            # switch to dns-01 (per the NixOS wiki) if you prefer not to expose
            # the challenge or want wildcard certs. Requests a SAN cert covering
            # every mail domain plus the announce hostname.
            acme."letsencrypt" = {
              directory = "https://acme-v02.api.letsencrypt.org/directory";
              contact = cfg.acmeContact;
              domains = cfg.domains ++ [ cfg.hostname ];
            };

            # ---- STORAGE ----
            # The NixOS module ALREADY defines a default RocksDB store named
            # "db" at /var/lib/stalwart-mail/db (that's why the unit's
            # ExecStartPre creates that directory). Do NOT define a second
            # store -- just point the storage roles at the existing "db" store.
            # (The earlier "Store not configured" was caused by pointing the
            #  roles at a separately-defined "rocksdb" store whose path didn't
            #  match the module-prepared directory.)
            storage = {
              data = "db"; # message + metadata store
              blob = "db"; # raw message blobs
              fts = "db"; # full-text search index
              lookup = "db"; # key-value lookups
              directory = "internal";
            };

            # Internal directory (accounts/aliases) persisted in the "db"
            # store, so runtime-created accounts survive rebuilds.
            directory.internal = {
              type = "internal";
              store = "db";
            };

            session.auth = {
              mechanisms = "[plain]";
              # Single-user server: allow sending from any of your alias /
              # catch-all addresses. On a MULTI-user server do NOT do this --
              # instead declare the few send-from addresses as real aliases.
              must-match-sender = false;
            };

            # Fallback admin: bootstrap only. Create real accounts in the UI.
            authentication.fallback-admin = {
              user = "admin";
              secret = "%{file:${adminPwInContainer}}%";
            };
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

        systemd.services.stalwart = {
          serviceConfig = {
            ProtectHome = lib.mkForce true;
            PrivateTmp = lib.mkForce true;
            ProtectControlGroups = lib.mkForce true;
            ProtectKernelTunables = lib.mkForce true;
            NoNewPrivileges = lib.mkForce true;
            RestrictAddressFamilies =
              lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
          };
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
