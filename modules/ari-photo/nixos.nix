{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.ari-photo;
  hostAddress = "192.168.100.62";
  localAddress = "192.168.100.63";
  port = 8080;
  ari-photo = pkgs.callPackage ./package.nix { };
  siteUrl = "https://${cfg.hostname}";
  envTemplate = "ari-photo.env";
in
{
  options.mine.system.ari-photo = {
    enable = lib.mkEnableOption "Ari Summerfield Photography website container behind Caddy";

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "summerfieldphotography.com";
    };

    redirectHostnames = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "www.summerfieldphotography.com"
        "arisummerfieldphotography.com"
        "www.arisummerfieldphotography.com"
      ];
      description = "Hostnames permanently redirected to the canonical hostname.";
    };

    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = "sops file holding ari-photo-smtp-password, the Stalwart password of the sending account.";
    };

    mail = {
      username = lib.mkOption {
        type = lib.types.str;
        description = "Stalwart account the site authenticates as.";
      };
      fromAddress = lib.mkOption {
        type = lib.types.str;
        description = "Sender of enquiry notifications and visitor acknowledgements; must be an address of the Stalwart account.";
      };
      fromName = lib.mkOption {
        type = lib.types.str;
        default = "Ari Summerfield Photography";
      };
      inboxAddress = lib.mkOption {
        type = lib.types.str;
        description = "Where enquiries are delivered.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.mine.system.stalwart.enable;
        message = "mine.system.ari-photo sends enquiries through the Stalwart container on the same host";
      }
    ];

    sops.secrets.ari-photo-smtp-password.sopsFile = cfg.sopsFile;
    sops.templates.${envTemplate} = {
      content = ''
        STALWART_SMTP_PASSWORD=${config.sops.placeholder.ari-photo-smtp-password}
      '';
      restartUnits = [ "container@ari-photo.service" ];
    };

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-ari-photo" ];
      externalInterface = config.mine.system.externalInterface;
    };

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

    services.caddy = {
      enable = true;
      virtualHosts = {
        ${cfg.hostname}.extraConfig = ''
          reverse_proxy ${localAddress}:${toString port}
        '';
      }
      // lib.genAttrs cfg.redirectHostnames (_: {
        extraConfig = ''
          redir ${siteUrl}{uri} permanent
        '';
      });
    };

    containers.ari-photo = {
      autoStart = true;
      privateNetwork = true;
      inherit hostAddress localAddress;

      bindMounts."/run/host-secrets/${envTemplate}" = {
        hostPath = config.sops.templates.${envTemplate}.path;
        isReadOnly = true;
      };

      config = _: {
        networking = {
          nameservers = [
            "9.9.9.9"
            "1.1.1.1"
          ];
          hosts.${config.containers.mail.localAddress} = [ config.mine.system.stalwart.hostname ];
          firewall = {
            enable = true;
            allowedTCPPorts = [ port ];
          };
        };

        systemd.services.ari-photo = {
          description = "Ari Summerfield Photography website";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];
          environment = {
            BIND_ADDRESS = "0.0.0.0:${toString port}";
            PHOTO_DIRECTORY = "${ari-photo}/share/ari_photo/photos";
            SITE_URL = siteUrl;
            TRUSTED_PROXIES = hostAddress;
            MAIL_SENDER = "stalwart";
            STALWART_SMTP_HOST = config.mine.system.stalwart.hostname;
            STALWART_SMTP_PORT = "465";
            STALWART_SMTP_USERNAME = cfg.mail.username;
            MAIL_FROM_ADDRESS = cfg.mail.fromAddress;
            MAIL_FROM_NAME = cfg.mail.fromName;
            ENQUIRY_INBOX_ADDRESS = cfg.mail.inboxAddress;
          };
          serviceConfig = {
            DynamicUser = true;
            ExecStart = lib.getExe ari-photo;
            EnvironmentFile = "/run/host-secrets/${envTemplate}";
            Restart = "on-failure";
            ProtectHome = true;
            PrivateTmp = true;
            ProtectSystem = "strict";
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

        system.stateVersion = "26.11";
      };
    };
  };
}
