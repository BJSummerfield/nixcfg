{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.photoform;
  hostStateDir = "/var/lib/photoform-data";
  photoform = pkgs.callPackage ./package.nix { };
in
{
  options.mine.system.photoform = {
    enable = lib.mkEnableOption "PhotoForm booking webapp container";

    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        sops file holding photoform-paypal-client-secret,
        photoform-smtp-password, photoform-admin-password and
        photoform-sheets-sa (the Google service-account JSON).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.mine.system.caddy.enable;
        message = "mine.system.photoform needs mine.system.caddy on the same host to be reachable";
      }
    ];

    sops.secrets = {
      photoform-paypal-client-secret.sopsFile = cfg.sopsFile;
      photoform-smtp-password.sopsFile = cfg.sopsFile;
      photoform-admin-password.sopsFile = cfg.sopsFile;
      photoform-sheets-sa.sopsFile = cfg.sopsFile;
    };

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-photoform" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.photoform-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
    '';

    mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
      routes.photoform = {
        hostnames = [ "booking.summerfieldphotography.com" ];
        mode = "tls";
        target = "192.168.100.51:8080";
      };
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "photoform" ];
    };

    containers.photoform = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.50";
      localAddress = "192.168.100.51";

      bindMounts = {
        "/var/lib/photoform" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };
        "/run/host-secrets/photoform-paypal-client-secret" = {
          hostPath = config.sops.secrets.photoform-paypal-client-secret.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-smtp-password" = {
          hostPath = config.sops.secrets.photoform-smtp-password.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-admin-password" = {
          hostPath = config.sops.secrets.photoform-admin-password.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-sheets-sa" = {
          hostPath = config.sops.secrets.photoform-sheets-sa.path;
          isReadOnly = true;
        };
      };

      config =
        { lib, ... }:
        {
          users.users.photoform = {
            isSystemUser = true;
            group = "photoform";
            home = "/var/lib/photoform";
          };
          users.groups.photoform = { };

          systemd.tmpfiles.rules = [
            "d /var/lib/photoform 0700 photoform photoform -"
          ];

          systemd.services.photoform = {
            description = "PhotoForm booking web service";
            wantedBy = [ "multi-user.target" ];
            after = [ "network.target" ];
            environment = {
              BOOKING_CONFIG = "${photoform}/${photoform.configPath}";
              BOOKING_PAYPAL_CLIENT_SECRET_FILE = "/run/credentials/photoform.service/paypal-client-secret";
              BOOKING_SMTP_PASSWORD_FILE = "/run/credentials/photoform.service/smtp-password";
              BOOKING_ADMIN_PASSWORD_FILE = "/run/credentials/photoform.service/admin-password";
              BOOKING_SHEETS_SERVICE_ACCOUNT_FILE = "/run/credentials/photoform.service/sheets-sa";
            };
            serviceConfig = {
              User = "photoform";
              Group = "photoform";
              ExecStart = lib.getExe photoform;
              LoadCredential = [
                "paypal-client-secret:/run/host-secrets/photoform-paypal-client-secret"
                "smtp-password:/run/host-secrets/photoform-smtp-password"
                "admin-password:/run/host-secrets/photoform-admin-password"
                "sheets-sa:/run/host-secrets/photoform-sheets-sa"
              ];
              WorkingDirectory = "/var/lib/photoform";
              Restart = "on-failure";
              ProtectHome = true;
              PrivateTmp = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/photoform" ];
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
              allowedTCPPorts = [ 8080 ];
            };
          };

          system.stateVersion = "24.11";
        };
    };
  };
}
