# PhotoForm booking webapp container, fronted publicly by the caddy edge.
# The package arrives only through the private binary cache — this host
# must never compile it. Each secret is a sops file bind-mounted in and
# loaded as a systemd credential, so no credential value ever enters the
# app's environment; the app's content lives in production.toml inside the
# package, so a new shoot is an app-repo commit plus a rev bump.
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
    # The container has no port on the external interface: without the edge
    # its route registration is inert and the site answers nowhere.
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

    # Outbound only (PayPal, Gmail SMTP, Google Sheets); inbound arrives
    # via the caddy edge on this host, never the external interface.
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

    # Stop-strategy: the brief nightly stop closes sqlite cleanly before
    # restic reads the host-side state dir.
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

          # Re-owns the bind mount to the container's photoform uid on start.
          systemd.tmpfiles.rules = [
            "d /var/lib/photoform 0700 photoform photoform -"
          ];

          systemd.services.photoform = {
            description = "PhotoForm booking web service";
            wantedBy = [ "multi-user.target" ];
            after = [ "network.target" ];
            # _FILE forms only: the app also accepts the value directly, but
            # that would put four credentials in /proc/<pid>/environ.
            environment = {
              BOOKING_CONFIG = "${photoform}/share/photoform/production.toml";
              BOOKING_PAYPAL_CLIENT_SECRET_FILE = "/run/credentials/photoform.service/paypal-client-secret";
              BOOKING_SMTP_PASSWORD_FILE = "/run/credentials/photoform.service/smtp-password";
              BOOKING_ADMIN_PASSWORD_FILE = "/run/credentials/photoform.service/admin-password";
              BOOKING_SHEETS_SERVICE_ACCOUNT_FILE = "/run/credentials/photoform.service/sheets-sa";
            };
            serviceConfig = {
              User = "photoform";
              Group = "photoform";
              ExecStart = lib.getExe photoform;
              # Copied by root into a per-unit tmpfs owned by User, which is
              # what makes a 0400 root-owned sops file readable here. The
              # credentials path is literal: /run/credentials/<unit> is
              # stable systemd API.
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
              # Only the host's caddy dials in, over ve-photoform.
              allowedTCPPorts = [ 8080 ];
            };
          };

          system.stateVersion = "24.11";
        };
    };
  };
}
