# Once the container is running log into it with
# sudo nixos-container root-login vikunja
# tailscale up --hostname=vikunja --advertise-tags=tag:solo-node
# tailscale serve --bg 3456

{ lib, config, pkgs, ... }:
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
    # Allow traffic to enter the container
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-vikunja" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Make needed directories on the host
    system.activationScripts.vikunja-dirs = ''
      mkdir -p /var/lib/vikunja-data
      chmod 700 /var/lib/vikunja-data
      mkdir -p /var/lib/vikunja-postgres
      chmod 700 /var/lib/vikunja-postgres
      mkdir -p /var/lib/tailscale-vikunja
      chmod 700 /var/lib/tailscale-vikunja
    '';

    containers.vikunja = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.22";
      localAddress = "192.168.100.23";

      # tun is needed for tailscale network
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        # Vikunja file uploads (attachments, avatars, backgrounds) + nightly DB dump
        "/var/lib/vikunja" = {
          hostPath = "/var/lib/vikunja-data";
          isReadOnly = false;
        };
        # Postgres data dir — persisted on host so DB survives container rebuilds
        "/var/lib/postgresql" = {
          hostPath = "/var/lib/vikunja-postgres";
          isReadOnly = false;
        };
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # persists the tailscale node
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-vikunja";
          isReadOnly = false;
        };
        # Host's sops-decrypted JWT secret, surfaced inside the container
        "/run/secrets/vikunja-jwt-secret" = {
          hostPath = cfg.jwtSecretFile;
          isReadOnly = true;
        };
      };

      config = { config, pkgs, lib, ... }: {
        services.vikunja = {
          enable = true;
          # Tailscale serve terminates TLS in front of us
          frontendScheme = "https";
          frontendHostname = "vikunja.mist-gamma.ts.net"; # change to your tailnet name
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
          ensureUsers = [{
            name = "vikunja";
            ensureDBOwnership = true;
          }];
        };

        # Nightly DB dump so restic has a consistent file to grab.
        # Lands inside /var/lib/vikunja so one backup path covers files + DB.
        systemd.services.vikunja-db-dump = {
          description = "Dump Vikunja Postgres DB for backup";
          serviceConfig = {
            Type = "oneshot";
            User = "postgres";
          };
          script = ''
            mkdir -p /var/lib/vikunja/db-dumps
            ${config.services.postgresql.package}/bin/pg_dump \
              -Fc vikunja > /var/lib/vikunja/db-dumps/vikunja.dump.tmp
            mv /var/lib/vikunja/db-dumps/vikunja.dump.tmp \
               /var/lib/vikunja/db-dumps/vikunja.dump
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
          "d /var/lib/vikunja/db-dumps 0750 postgres postgres -"
        ];

        # sets the tailscale params
        services.tailscale.enable = true;

        networking = {
          # needed to get dns for https nameserver
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            # allows connection from other tailscale devices
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        # Hardening the Vikunja service
        systemd.services.vikunja = {
          serviceConfig = {
            ProtectHome = lib.mkForce true;
            PrivateTmp = lib.mkForce true;
            ProtectControlGroups = lib.mkForce true;
            ProtectKernelTunables = lib.mkForce true;
            NoNewPrivileges = lib.mkForce true;
            RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
          };
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
