{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.switchyard;
  hostStateDir = "/var/lib/switchyard-data";
  hostAddress = "192.168.100.60";
  localAddress = "192.168.100.61";
  port = 3000;
  switchyard = pkgs.callPackage ./package.nix { };
  hasLogins = cfg.sopsFile != null;
in
{
  options.mine.system.switchyard = {
    enable = lib.mkEnableOption "Switchyard order-taking webapp container behind Caddy";

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "switchyard.brianjs.com";
    };

    persistent = lib.mkEnableOption "a file-backed SQLite database in a host directory that the nightly backup covers; without it the database is in memory and is lost on every restart";

    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "sops file holding switchyard-admin-password-hash and switchyard-worker-password-hash (argon2id PHC strings). Null keeps the app's default logins admin/admin and worker/worker.";
    };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = lib.mkIf hasLogins {
      switchyard-admin-password-hash.sopsFile = cfg.sopsFile;
      switchyard-worker-password-hash.sopsFile = cfg.sopsFile;
    };

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-switchyard" ];
      externalInterface = config.mine.system.externalInterface;
    };

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

    services.caddy = {
      enable = true;
      virtualHosts.${cfg.hostname}.extraConfig = ''
        reverse_proxy ${localAddress}:${toString port}
      '';
    };

    system.activationScripts.switchyard-dirs = lib.mkIf cfg.persistent ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
    '';

    mine.backups = lib.mkIf (cfg.persistent && config.mine.backups.enable) {
      paths = [ hostStateDir ];
      stopContainers = [ "switchyard" ];
    };

    containers.switchyard = {
      autoStart = true;
      privateNetwork = true;
      inherit hostAddress localAddress;

      bindMounts =
        lib.optionalAttrs cfg.persistent {
          "/var/lib/switchyard" = {
            hostPath = hostStateDir;
            isReadOnly = false;
          };
        }
        // lib.optionalAttrs hasLogins {
          "/run/host-secrets/admin-password-hash" = {
            hostPath = config.sops.secrets.switchyard-admin-password-hash.path;
            isReadOnly = true;
          };
          "/run/host-secrets/worker-password-hash" = {
            hostPath = config.sops.secrets.switchyard-worker-password-hash.path;
            isReadOnly = true;
          };
        };

      config = _: {
        users.users.switchyard = {
          isSystemUser = true;
          group = "switchyard";
          home = "/var/lib/switchyard";
        };
        users.groups.switchyard = { };

        systemd.tmpfiles.rules = [
          "d /var/lib/switchyard 0700 switchyard switchyard -"
        ];

        systemd.services.switchyard = {
          description = "Switchyard order taking and pickup tracking";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];
          environment = {
            ADDR = "0.0.0.0:${toString port}";
            TRUSTED_PROXIES = hostAddress;
          }
          // lib.optionalAttrs cfg.persistent {
            DATABASE_URL = "sqlite:///var/lib/switchyard/switchyard.db?mode=rwc";
          }
          // lib.optionalAttrs hasLogins {
            ADMIN_PASSWORD_HASH_FILE = "/run/credentials/switchyard.service/admin-password-hash";
            WORKER_PASSWORD_HASH_FILE = "/run/credentials/switchyard.service/worker-password-hash";
          };
          serviceConfig = {
            User = "switchyard";
            Group = "switchyard";
            ExecStart = lib.getExe switchyard;
            LoadCredential = lib.optionals hasLogins [
              "admin-password-hash:/run/host-secrets/admin-password-hash"
              "worker-password-hash:/run/host-secrets/worker-password-hash"
            ];
            WorkingDirectory = "/var/lib/switchyard";
            Restart = "on-failure";
            ProtectHome = true;
            PrivateTmp = true;
            ProtectSystem = "strict";
            ReadWritePaths = [ "/var/lib/switchyard" ];
            ProtectControlGroups = true;
            ProtectKernelTunables = true;
            NoNewPrivileges = true;
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
            ];
          };
        };

        networking = {
          nameservers = [
            "9.9.9.9"
            "1.1.1.1"
          ];
          firewall = {
            enable = true;
            allowedTCPPorts = [ port ];
          };
        };

        system.stateVersion = "26.11";
      };
    };
  };
}
