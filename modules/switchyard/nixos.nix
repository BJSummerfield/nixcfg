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
in
{
  options.mine.system.switchyard = {
    enable = lib.mkEnableOption "Switchyard order-taking webapp container behind Caddy";

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "switchyard.brianjs.com";
    };

    eventTimeZone = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "America/Chicago";
      description = "IANA time zone the Sales page buckets sales by hour in. Null leaves the app's default, UTC.";
    };
  };

  config = lib.mkIf cfg.enable {
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

    system.activationScripts.switchyard-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
    '';

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "switchyard" ];
    };

    containers.switchyard = {
      autoStart = true;
      privateNetwork = true;
      inherit hostAddress localAddress;

      bindMounts."/var/lib/switchyard" = {
        hostPath = hostStateDir;
        isReadOnly = false;
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
            DATABASE_URL = "sqlite:///var/lib/switchyard/switchyard.db?mode=rwc";
            TRUSTED_PROXIES = hostAddress;
          }
          // lib.optionalAttrs (cfg.eventTimeZone != null) {
            EVENT_TIMEZONE = cfg.eventTimeZone;
          };
          serviceConfig = {
            User = "switchyard";
            Group = "switchyard";
            ExecStart = lib.getExe switchyard;
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
