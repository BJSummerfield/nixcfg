{ lib, config, ... }:
{
  options.mine.system.jellyfin-server.enable = lib.mkEnableOption "Enable Jellyfin-server container";

  config = lib.mkIf config.mine.system.jellyfin-server.enable {

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-+" ];
      externalInterface = "enp34s0";
    };

    containers.jellyfin = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";
      bindMounts = {
        "/media" = {
          hostPath = "/srv/media";
        };
      };
      config = { config, pkgs, lib, ... }: {

        services.jellyfin.enable = true;
        networking = {
          firewall = {
            enable = true;
            allowedTCPPorts = [ 8096 ];
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

            # Restrict the type of network sockets the app can open
            RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
          };
        };

        system.stateVersion = "24.11"; # Update to your current NixOS version
      };
    };
  };
}
