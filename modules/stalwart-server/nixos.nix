#   sudo nixos-container root-login stalwart
#   tailscale up --hostname=stalwart --advertise-tags=tag:solo-node --accept-dns=false
#   tailscale serve --bg --https=8443 8080
#     (use 8443 -- Admin UI: https://stalwart.mist-gamma.ts.net:8443)
#
#   1. Log in: admin / the inline fallback password below. CHANGE it in the UI.
#   2. Settings -> TLS/ACME: configure Let's Encrypt (directory, contact,
#      domains = brianjs.com + mx1.brianjs.com).
#   3. Settings -> Server/Hostname: set hostname to mx1.brianjs.com.
#   4. Settings -> Authentication: set must-match-sender = true.
#   5. Domains: create brianjs.com -> read the generated DNS records (DKIM etc.)
#      and add them at Namecheap.
#   6. Accounts: create your real mailbox + aliases.

{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.system.stalwart-server;
  hostStateDir = "/var/lib/stalwart-data";
in
{
  options.mine.system.stalwart-server = {
    enable = lib.mkEnableOption "Enable Stalwart all-in-one mail server container";
    adminPasswordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to the decrypted fallback-admin secret (e.g.
                config.sops.secrets.stalwart-admin-pw.path). Owned by stalwartUid,
                bind-mounted read-only into the container. Store an argon2 hash; log in
                with the plaintext.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    system.activationScripts.stalwart-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
      mkdir -p /var/lib/tailscale-stalwart
      chmod 700 /var/lib/tailscale-stalwart
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

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "stalwart" ];
    };

    mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
      routes.mail = {
        hostnames = [ "mx1.brianjs.com" ];
        mode = "tcp";
        target = "192.168.100.41:443";
      };
    };

    containers.stalwart = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.40";
      localAddress = "192.168.100.41";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
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
                  management = {
                    protocol = "http";
                    bind = [ "127.0.0.1:8080" ];
                  };
                };
              };

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

              authentication.fallback-admin = {
                user = "admin";
                secret = "%{file:/run/credentials/stalwart.service/admin-pw}%";
              };
            };
          };

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
