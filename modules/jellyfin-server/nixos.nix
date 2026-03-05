{ lib, config, pkgs, ... }:
{
  options.mine.system.jellyfin-server.enable = lib.mkEnableOption "Enable Jellyfin-server container";

  config = lib.mkIf config.mine.system.jellyfin-server.enable {

    # systemd.services."container-jellyfin-network" = {
    #   description = "Bring up ve-jellyfin interface and restart container tailscale";
    #   after = [ "container@jellyfin.service" ];
    #   requires = [ "container@jellyfin.service" ];
    #   wantedBy = [ "multi-user.target" ];
    #   serviceConfig = {
    #     Type = "oneshot";
    #     RemainAfterExit = true;
    #   };
    #   script = ''
    #     ${pkgs.iproute2}/bin/ip link set ve-jellyfin up
    #     ${pkgs.iproute2}/bin/ip addr add 192.168.100.10/24 dev ve-jellyfin || true
    #     sleep 2
    #     ${pkgs.nixos-container}/bin/nixos-container run jellyfin -- systemctl restart tailscaled
    #   '';
    # };
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-jellyfin" ];
      externalInterface = "enp34s0";
    };

    # networking.firewall = {
    #   checkReversePath = "loose";
    #   trustedInterfaces = [ "ve-+" ];
    # };
    # 

    containers.jellyfin = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";


      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      # extraFlags = [ "--property=DeviceAllow=/dev/net/tun" ];

      bindMounts = {
        "/media" = {
          hostPath = "/srv/media";
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # "/var/lib/tailscale" = {
        #   hostPath = "/var/lib/tailscale-jellyfin";
        #   isReadOnly = false;
        # };
        "/run/tailscale-auth" = {
          hostPath = "/etc/tailscale-jellyfin-key";
          isReadOnly = true;
        };
      };
      config = { config, pkgs, lib, ... }: {

        systemd.services.tailscaled-autoconnect.serviceConfig.Type = lib.mkForce "simple";
        services.tailscale = {
          enable = true;
          authKeyFile = "/run/tailscale-auth";
          extraUpFlags = [
            "--hostname=jellyfintest"
            "--advertise-tags=tag:media"
          ];
        };

        services.jellyfin.enable = true;
        networking = {
          firewall = {
            enable = true;
            allowedTCPPorts = [ 8096 ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        # systemd.tmpfiles.rules = [
        #   "d /var/lib/tailscale-jellyfin 0700 root root -"
        #   "d /var/lib/nixos-containers/jellyfin/dev/net 0755 root root -"
        #   "f /var/lib/nixos-containers/jellyfin/dev/net/tun 0666 root root -"
        #   "d /run/secrets 0700 root root -"
        # ];

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
