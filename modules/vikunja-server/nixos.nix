# Bring-up:
#   sudo nixos-container root-login vikunja
#   tailscale up --hostname=vikunja --advertise-tags=tag:solo-node
#   tailscale serve --bg 3456

{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.vikunja-server;
in
{
  options.mine.system.vikunja-server = {
    enable = lib.mkEnableOption "Enable Vikunja task manager container";

    jwtSecretFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path on the host to a file containing the Vikunja JWT secret as an
        environment variable, e.g. `VIKUNJA_SERVICE_JWTSECRET=<hex>`.
        Typically the decrypted path from sops-nix.
      '';
      example = "/run/secrets/vikunja-jwt-secret";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-vikunja" ];
      externalInterface = config.mine.system.externalInterface;
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/vikunja-dumps" ];
    };

    # Tailscale state and the DB dump are the only things persisted on the
    # host directly; Vikunja files + Postgres data live in the container's
    # rootfs (/var/lib/nixos-containers/vikunja/), which survives rebuilds.
    # The nightly dump at /var/lib/vikunja-dumps is what mine.backups ships.
    system.activationScripts.vikunja-dirs = ''
      mkdir -p /var/lib/tailscale-vikunja
      chmod 700 /var/lib/tailscale-vikunja
      mkdir -p /var/lib/vikunja-dumps
      chmod 700 /var/lib/vikunja-dumps
    '';

    containers.vikunja = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.22";
      localAddress = "192.168.100.23";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # persists the tailscale node identity across container restarts
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-vikunja";
          isReadOnly = false;
        };
        # Host's sops-decrypted JWT secret, surfaced inside the container
        "/run/secrets/vikunja-jwt-secret" = {
          hostPath = cfg.jwtSecretFile;
          isReadOnly = true;
        };
        # Surfaces the nightly pg_dump on the host for the host-side restic
        # job; the container's tmpfiles rule re-owns it to postgres.
        "/var/lib/postgresql/dumps" = {
          hostPath = "/var/lib/vikunja-dumps";
          isReadOnly = false;
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
          services.vikunja = {
            enable = true;
            # Tailscale serve terminates TLS in front of us
            frontendScheme = "https";
            frontendHostname = "vikunja.mist-gamma.ts.net";
            port = 3456;
            environmentFiles = [ "/run/secrets/vikunja-jwt-secret" ];
            database = {
              type = "postgres";
              host = "/run/postgresql"; # unix socket — no password
              user = "vikunja";
              database = "vikunja";
            };
            settings = {
              service = {
                enableregistration = true; # flip to false after creating your account
                # JWTSecret deliberately omitted — comes from environmentFiles
              };
            };
          };

          services.postgresql = {
            enable = true;
            ensureDatabases = [ "vikunja" ];
            ensureUsers = [
              {
                name = "vikunja";
                ensureDBOwnership = true;
              }
            ];
          };

          # Nightly DB dump for the host-side restic job; -Fc so restores
          # work across Postgres versions, and tmp-then-mv keeps restic
          # from shipping a torn dump.
          systemd.services.vikunja-db-dump = {
            description = "Dump Vikunja Postgres DB for backup";
            serviceConfig = {
              Type = "oneshot";
              User = "postgres";
            };
            script = ''
              mkdir -p /var/lib/postgresql/dumps
              ${config.services.postgresql.package}/bin/pg_dump \
                -Fc vikunja > /var/lib/postgresql/dumps/vikunja.dump.tmp
              mv /var/lib/postgresql/dumps/vikunja.dump.tmp \
                 /var/lib/postgresql/dumps/vikunja.dump
            '';
          };
          systemd.timers.vikunja-db-dump = {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnCalendar = "daily";
              Persistent = true;
            };
          };
          systemd.tmpfiles.rules = [
            "d /var/lib/postgresql/dumps 0750 postgres postgres -"
          ];

          services.tailscale.enable = true;

          networking = {
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          systemd.services.vikunja = {
            serviceConfig = {
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
          };

          system.stateVersion = "24.11";
        };
    };
  };
}
