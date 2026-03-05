{ lib, config, pkgs, ... }:
{
  options.mine.system.jellyfin-server = {
    enable = lib.mkEnableOption "Enable Jellyfin-server container";
    externalInterface = lib.mkOption {
      type = lib.types.str;
      description = "External network interface for NAT";
    };
  };

  config = lib.mkIf config.mine.system.jellyfin-server.enable {

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-jellyfin" ];
      externalInterface = config.mine.system.jellyfin-server.externalInterface;
    };

    system.activationScripts.jellyfin-dirs = ''
      mkdir -p /srv/media
      mkdir -p /var/lib/tailscale-jellyfin
      chmod 755 /srv/media
      chmod 700 /var/lib/tailscale-jellyfin
    '';

    containers.jellyfin = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";


      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        "/media" = {
          hostPath = "/srv/media";
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-jellyfin";
          isReadOnly = false;
        };
        "/run/tailscale-auth" = {
          hostPath = "/etc/tailscale-jellyfin-key";
          isReadOnly = true;
        };
      };
      config = { config, pkgs, lib, ... }: {
        systemd.services.tailscaled-autoconnect = {
          serviceConfig = {
            Type = lib.mkForce "simple";
            Restart = "on-failure";
            RestartSec = 5;
          };
        };

        services.tailscale = {
          enable = true;
          authKeyFile = "/run/tailscale-auth";
          extraUpFlags = [
            "--hostname=jellyfintest"
            "--advertise-tags=tag:media"
          ];
        };

        systemd.services.tailscale-serve = {
          description = "Tailscale Serve for Jellyfin";
          after = [ "tailscaled-autoconnect.service" "jellyfin.service" ];
          wants = [ "tailscaled-autoconnect.service" "jellyfin.service" ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = 10;
          };
          script = ''
            ${pkgs.tailscale}/bin/tailscale serve --bg 8096
          '';
        };

        services.jellyfin.enable = true;
        networking = {
          nameservers = [ "1.1.1.1" "8.8.8.8" ];
          firewall = {
            enable = true;
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        systemd.services.jellyfin = {
          serviceConfig = {
            DynamicUser = lib.mkForce true;
            StateDirectory = "jellyfin";
            CacheDirectory = "jellyfin";
            ProtectSystem = lib.mkForce "strict";
            ProtectHome = lib.mkForce true;
            PrivateTmp = lib.mkForce true;
            PrivateDevices = lib.mkForce true;
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
