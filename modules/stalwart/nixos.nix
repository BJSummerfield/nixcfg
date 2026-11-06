#   sudo nixos-container root-login mail
#   tailscale up --hostname=mail --advertise-tags=tag:solo-node --accept-dns=false
#   tailscale serve --bg --https=8443 8080
#     (admin UI: https://mail.mist-gamma.ts.net:8443, log in as admin with the
#      password from adminPasswordFile)
#   systemctl restart stalwart, once after the first stalwart-provision run
#     (listener changes only bind on restart)
#   Create the mailbox account in the UI.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.stalwart;
  hostStateDir = "/var/lib/stalwart-mail-1";
  hostTailscaleDir = "/var/lib/tailscale-stalwart-mail-1";
  configFile = pkgs.writeText "stalwart-config.json" (
    builtins.toJSON {
      "@type" = "RocksDb";
      path = "/var/lib/stalwart/db";
    }
  );
  startScript = pkgs.writeShellScript "stalwart-start" ''
    export STALWART_RECOVERY_ADMIN="admin:$(< "$CREDENTIALS_DIRECTORY/admin-pw")"
    export STALWART_HOSTNAME=${lib.escapeShellArg cfg.hostname}
    export STALWART_PUBLIC_URL=${lib.escapeShellArg cfg.publicUrl}
    exec ${pkgs.stalwart_1_0}/bin/stalwart --config=${configFile}
  '';
in
{
  options.mine.system.stalwart = {
    enable = lib.mkEnableOption "Enable the Stalwart 1.0 all-in-one mail server container";

    hostname = lib.mkOption {
      type = lib.types.str;
      default = "mx1.brianjs.com";
    };

    domain = lib.mkOption {
      type = lib.types.str;
      default = "brianjs.com";
    };

    adminPasswordFile = lib.mkOption {
      type = lib.types.externalPath;
      description = "Host path of the plaintext fallback-admin password, bind-mounted read-only into the container.";
    };

    acme.contact = lib.mkOption {
      type = lib.types.str;
      default = "postmaster@brianjs.com";
    };

    acme.staging = lib.mkOption {
      type = lib.types.bool;
      default = true;
    };

    namecheap = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            apiUser = lib.mkOption {
              type = lib.types.str;
            };
            username = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
            };
            clientIp = lib.mkOption {
              type = lib.types.str;
            };
            apiKeyFile = lib.mkOption {
              type = lib.types.externalPath;
            };
          };
        }
      );
      default = null;
    };

    publishRecords = lib.mkOption {
      type = lib.types.listOf (
        lib.types.enum [
          "dkim"
          "spf"
          "mx"
          "dmarc"
          "caa"
          "mtaSts"
          "tlsRpt"
          "autoConfig"
          "autoConfigLegacy"
          "autoDiscover"
        ]
      );
      default = [ "dkim" ];
    };

    publicAccess = lib.mkOption {
      type = lib.types.bool;
      default = false;
    };

    publicUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://mail.mist-gamma.ts.net:8443";
    };

    planFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      description = "The NDJSON settings plan applied by the stalwart-provision unit.";
    };
  };

  config = lib.mkIf cfg.enable {
    mine.system.stalwart.planFile = import ./render.nix {
      inherit lib cfg;
      inherit (pkgs) writeText;
      webui = pkgs.stalwart_1_0.webui;
    };
    assertions = [
      {
        message = ''
          mine.system.stalwart.publicAccess and mine.system.stalwart-server.enable
          cannot both be true: the two servers would claim the same mail ports.
        '';
        assertion = !(cfg.publicAccess && config.mine.system.stalwart-server.enable);
      }
      {
        message = "mine.system.stalwart.publishRecords must not be empty when namecheap is set: Stalwart rejects an empty record set";
        assertion = cfg.namecheap == null || cfg.publishRecords != [ ];
      }
    ];

    system.activationScripts.stalwart-mail-1-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
      mkdir -p ${hostTailscaleDir}
      chmod 700 ${hostTailscaleDir}
    '';

    networking.firewall.allowedTCPPorts = lib.optionals cfg.publicAccess [
      25
      465
      993
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-mail" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = lib.optionals cfg.publicAccess (
        map
          (p: {
            sourcePort = p;
            destination = "192.168.100.43:${toString p}";
            proto = "tcp";
          })
          [
            25
            465
            993
          ]
      );
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "mail" ];
    };

    containers.mail = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.42";
      localAddress = "192.168.100.43";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
        "/var/lib/stalwart" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = hostTailscaleDir;
          isReadOnly = false;
        };
        "/run/stalwart/admin-pw" = {
          hostPath = cfg.adminPasswordFile;
          isReadOnly = true;
        };
      }
      // lib.optionalAttrs (cfg.namecheap != null) {
        "/run/stalwart/namecheap-key" = {
          hostPath = cfg.namecheap.apiKeyFile;
          isReadOnly = true;
        };
      };

      config =
        {
          config,
          lib,
          ...
        }:
        {
          users.users.stalwart = {
            isSystemUser = true;
            group = "stalwart";
          };
          users.groups.stalwart = { };

          systemd.tmpfiles.rules = [ "d /var/lib/stalwart 0700 stalwart stalwart - -" ];

          systemd.services.stalwart = {
            description = "Stalwart 1.0 mail server";
            wantedBy = [ "multi-user.target" ];
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            serviceConfig = {
              Type = "notify";
              User = "stalwart";
              Group = "stalwart";
              LoadCredential = [
                "admin-pw:/run/stalwart/admin-pw"
              ]
              ++ lib.optional (cfg.namecheap != null) "namecheap-key:/run/stalwart/namecheap-key";
              ExecStart = startScript;
              KillMode = "process";
              KillSignal = "SIGINT";
              Restart = "on-failure";
              RestartSec = 5;
              LimitNOFILE = 65536;
              AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
              CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
              NoNewPrivileges = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/stalwart" ];
              PrivateTmp = true;
              ProtectHome = true;
              RestrictAddressFamilies = [
                "AF_UNIX"
                "AF_INET"
                "AF_INET6"
                "AF_NETLINK"
              ];
            };
          };

          systemd.services.stalwart-provision = {
            description = "Apply the Stalwart settings plan";
            wantedBy = [ "multi-user.target" ];
            requires = [ "stalwart.service" ];
            after = [ "stalwart.service" ];
            partOf = [ "stalwart.service" ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              User = "stalwart";
              LoadCredential = [ "admin-pw:/run/stalwart/admin-pw" ];
              TimeoutStartSec = 180;
            };
            script = ''
              curl=${pkgs.curl}/bin/curl
              sleep=${pkgs.coreutils}/bin/sleep
              deadline=60
              ok=0
              while [ "$deadline" -gt 0 ]; do
                if "$curl" -sf --max-time 2 -o /dev/null http://127.0.0.1:8080/healthz/live; then
                  ok=1
                  break
                fi
                "$sleep" 1
                deadline=$((deadline - 1))
              done
              if [ "$ok" -ne 1 ]; then
                echo "stalwart did not answer http://127.0.0.1:8080/healthz/live within 60s" >&2
                exit 1
              fi
              export STALWART_URL=http://127.0.0.1:8080
              export STALWART_USER=admin
              export STALWART_PASSWORD="$(< "$CREDENTIALS_DIRECTORY/admin-pw")"
              exec ${pkgs.stalwart-cli}/bin/stalwart-cli apply --file ${cfg.planFile}
            '';
          };

          services.tailscale.enable = true;

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
              ];
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          system.stateVersion = "26.11";
        };
    };
  };
}
