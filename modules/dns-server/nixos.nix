# Once the container is running log into it with
# sudo nixos-container root-login dns
# tailscale up --hostname=dns --advertise-tags=tag:solo-node --accept-dns=false
# tailscale serve --bg 3000

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.dns-server;
in
{
  options.mine.system.dns-server = {
    enable = lib.mkEnableOption "Enable AdGuard Home + Unbound DNS container";

    lanPort = lib.mkOption {
      type = lib.types.port;
      default = 53;
      description = "Port exposed on the LAN for DNS queries";
    };

    webPort = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "AdGuard Home admin UI port";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = [ cfg.lanPort cfg.webPort ];
    networking.firewall.allowedUDPPorts = [ cfg.lanPort ];


    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-dns" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        {
          sourcePort = cfg.lanPort;
          destination = "192.168.100.15:${toString cfg.lanPort}";
          proto = "tcp";
        }
        {
          sourcePort = cfg.lanPort;
          destination = "192.168.100.15:${toString cfg.lanPort}";
          proto = "udp";
        }
        {
          sourcePort = cfg.webPort;
          destination = "192.168.100.15:${toString cfg.webPort}";
          proto = "tcp";
        }
      ];
    };

    system.activationScripts.dns-dirs = ''
      mkdir -p /var/lib/adguardhome-data
      chmod 700 /var/lib/adguardhome-data
      mkdir -p /var/lib/tailscale-dns
      chmod 700 /var/lib/tailscale-dns
    '';

    containers.dns = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.14";
      localAddress = "192.168.100.15";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        "/var/lib/AdGuardHome" = {
          hostPath = "/var/lib/adguardhome-data";
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-dns";
          isReadOnly = false;
        };
      };

      config = { config, pkgs, lib, ... }: {
        services.unbound = {
          enable = true;
          settings = {
            server = {
              interface = [ "127.0.0.1" ];
              port = 5335;
              access-control = [ "127.0.0.0/8 allow" ];
              do-ip4 = true;
              do-ip6 = false;
              do-udp = true;
              do-tcp = true;

              hide-identity = true;
              hide-version = true;

              harden-glue = true;
              harden-dnssec-stripped = true;
              harden-below-nxdomain = true;
              harden-referral-path = true;
              use-caps-for-id = false;

              qname-minimisation = true;
              aggressive-nsec = true;

              prefetch = true;
              prefetch-key = true;
              cache-min-ttl = 300;
              cache-max-ttl = 86400;
              msg-cache-size = "50m";
              rrset-cache-size = "100m";

              edns-buffer-size = 1232;

              private-address = [
                "192.168.0.0/16"
                "172.16.0.0/12"
                "10.0.0.0/8"
                "fd00::/8"
                "fe80::/10"
              ];
            };
          };
        };

        services.adguardhome = {
          enable = true;
          openFirewall = false;
          mutableSettings = true;
          host = "0.0.0.0";
          port = cfg.webPort;
          settings = {
            # make admin user and password with:
            # nix shell nixpkgs#apacheHttpd
            # htpasswd -B -C 10 -n admin
            users = [
              {
                name = "admin";
                password = "$2y$10$c9v44L8TQVKoAAZqHiO9peVSoMWNShGzL9nOdLgE5R8H8sEh0FoJi";
              }
            ];
            dns = {
              bind_hosts = [ "0.0.0.0" ];
              port = cfg.lanPort;
              upstream_dns = [ "127.0.0.1:5335" ];
              bootstrap_dns = [ "9.9.9.9" "1.1.1.1" ];
              enable_dnssec = false;
              cache_size = 4194304;
              cache_ttl_min = 60;
              cache_ttl_max = 86400;
            };
            filtering = {
              protection_enabled = true;
              filtering_enabled = true;
            };
          };
        };

        services.tailscale.enable = true;

        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            allowedTCPPorts = [ cfg.lanPort cfg.webPort ];
            allowedUDPPorts = [ cfg.lanPort config.services.tailscale.port ];
            trustedInterfaces = [ "tailscale0" ];
          };
        };

        systemd.services.unbound.serviceConfig = {
          ProtectHome = lib.mkForce true;
          PrivateTmp = lib.mkForce true;
          ProtectControlGroups = lib.mkForce true;
          ProtectKernelTunables = lib.mkForce true;
          NoNewPrivileges = lib.mkForce true;
          RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        };

        systemd.services.adguardhome.serviceConfig = {
          DynamicUser = lib.mkForce false;
          ProtectHome = lib.mkForce true;
          PrivateTmp = lib.mkForce true;
          ProtectControlGroups = lib.mkForce true;
          ProtectKernelTunables = lib.mkForce true;
          NoNewPrivileges = lib.mkForce true;
          RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        };
        system.stateVersion = "24.11";
      };
    };
  };
}
