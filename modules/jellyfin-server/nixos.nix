{ lib, config, ... }:
{
  options.mine.system.jellyfin-server.enable = lib.mkEnableOption "Enable Jellyfin-server container";

  config = lib.mkIf config.mine.system.jellyfin-server.enable {


    containers.jellyfin = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";
      # 1. Mount your media from the host into the container securely
      # bindMounts = {
      #   "/media/movies" = {
      #     hostPath = "/mnt/host-nas/movies"; # Change this to your actual host path
      #     isReadOnly = true; # Hard-locks the directory so the app cannot delete files
      #   };
      # };

      config = { config, pkgs, lib, ... }: {
        services.jellyfin.enable = true;
        networking.firewall = {
          enable = true;
          allowedTCPPorts = [ 8096 ];
        };

        # 2. Aggressively sandbox the application via systemd
        systemd.services.jellyfin = {
          serviceConfig = {
            # mkForce overrides the default module to enforce a Ghost User
            DynamicUser = lib.mkForce true;

            # Systemd will create these folders, let the ghost user own them while running, 
            # and persist your watch history/database safely across reboots.
            StateDirectory = "jellyfin";
            CacheDirectory = "jellyfin";

            ProtectSystem = "strict"; # Mounts the ENTIRE OS read-only to Jellyfin
            ProtectHome = true; # Completely hides /home and /root directories
            PrivateTmp = true; # Gives Jellyfin its own isolated, empty /tmp folder
            PrivateDevices = true; # Hides physical hardware (like /dev/sda) from the app
            ProtectControlGroups = true; # Prevents the app from tampering with resource limits
            ProtectKernelTunables = true; # Prevents the app from modifying kernel variables
            NoNewPrivileges = true; # Blocks the app from escalating privileges (e.g., via sudo)

            # Restrict the type of network sockets the app can open
            RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
          };
        };

        system.stateVersion = "23.11"; # Update to your current NixOS version
      };
    };
  };
}
