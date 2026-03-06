# Required: Create the Tailscale OAuth key file before enabling:
#   echo "tskey-client-..." | sudo tee /etc/tailscale-jellyfin-key
#   sudo chmod 600 /etc/tailscale-jellyfin-key

{ lib, config, ... }:
{
  options.mine.system.jellyfin-server = {
    enable = lib.mkEnableOption "Enable Jellyfin-server container";
    externalInterface = lib.mkOption {
      type = lib.types.str;
      description = "External network interface for NAT";
    };
  };

  config = lib.mkIf config.mine.system.jellyfin-server.enable {
    # ensures nfs will work on any machine
    boot.supportedFilesystems = [ "nfs" ];
    services.rpcbind.enable = true;
    fileSystems = {
      "/mnt/secure/nas" = {
        device = "192.168.1.234:/volume1/data";
        fsType = "nfs";
        options = [
          "x-systemd.automount"
          "noauto"
          "x-systemd.idle-timeout=600"
          "nfsvers=3"
          "soft"
          "timeo=150"
          "retrans=2"
        ];
      };
    };

    # host level group id for nfs mount
    users.groups.media.gid = 65540;

    # Expose app to lan - not needed if only being accessed through tailnet
    networking.firewall.allowedTCPPorts = [ 8096 ];
    networking.nat.forwardPorts = [
      {
        sourcePort = 8096;
        destination = "192.168.100.11:8096";
        proto = "tcp";
      }
    ];

    # Allow traffic to enter the container
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-jellyfin" ];
      externalInterface = config.mine.system.jellyfin-server.externalInterface;
    };

    # Make needed directories
    system.activationScripts.jellyfin-dirs = ''
      mkdir -p /var/lib/tailscale-jellyfin
      chmod 700 /var/lib/tailscale-jellyfin
    '';

    containers.jellyfin = {

      # Mapping container to a local port
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";

      # tun is needed for tailscale network
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];


      bindMounts = {
        "/media" = {
          hostPath = "/mnt/secure/nas";
        };
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # persists the tailscale node
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-jellyfin";
          isReadOnly = false;
        };
        # where to find the auth key
        "/run/tailscale-auth" = {
          hostPath = "/etc/tailscale-jellyfin-key";
          isReadOnly = true;
        };
      };
      config = { config, pkgs, lib, ... }: {
        # container level gid for the media group and nfs mount
        users.groups.media.gid = 65540;

        systemd.services.tailscaled-autoconnect = {
          serviceConfig = {
            # fix for tailscale not creating the veth for the container
            Type = lib.mkForce "simple";
            Restart = "on-failure";
            RestartSec = 5;
          };
        };

        # sets the tailscale params
        services.tailscale = {
          enable = true;
          authKeyFile = "/run/tailscale-auth";
          extraUpFlags = [
            "--hostname=jellyfintest"
            "--advertise-tags=tag:media"
          ];
        };

        # runs tailscale serve once the apps are ready
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
          # needed to get the dns for https nameserver
          nameservers = [ "1.1.1.1" "8.8.8.8" ];
          firewall = {
            enable = true;
            # Lan access
            allowedTCPPorts = [ 8096 ];
            # allows connection from other tailscale devices
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        # Hardening the container
        systemd.services.jellyfin = {
          serviceConfig = {
            DynamicUser = lib.mkForce true;
            # add the service to the media group
            SupplementaryGroups = [ "media" ];
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
