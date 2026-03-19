{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.immich-server;
  nasCfg = config.mine.system.nas;
  renderGid = config.mine.system.renderGroupGid;
  homesRoGid = nasCfg.shares.homes.roGid;
  homesMountPoint = nasCfg.shares.homes.mountPoint;
  immichRwGid = nasCfg.shares.immich.rwGid;
  immichMountPoint = nasCfg.shares.immich.mountPoint;
in
{
  options.mine.system.immich-server = {
    enable = lib.mkEnableOption "Enable Immich photo server container";

    photosSubdir = lib.mkOption {
      type = lib.types.str;
      default = "photos";
      description = "Subdirectory under the homes NAS mount where photos live";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = renderGid != null;
        message = "mine.system.renderGroupGid must be set to use immich-server";
      }
      {
        assertion = homesRoGid != null;
        message = "NAS homes share must have roGid defined to use immich-server";
      }
      {
        assertion = immichRwGid != null;
        message = "NAS immich share must have rwGid defined to use immich-server";
      }
    ];

    # Enable the NAS shares as persistent
    mine.system.nas.shares.homes = {
      enable = true;
      persistent = true;
    };

    mine.system.nas.shares.immich = {
      enable = true;
      persistent = true;
    };

    # Mesa/radeonsi provides VAAPI for Vega iGPU out of the box
    hardware.graphics = {
      enable = true;
    };

    users.groups.render.gid = renderGid;

    # LAN access on Immich default port
    networking.firewall.allowedTCPPorts = [ 2283 ];

    networking.nat.forwardPorts = [
      {
        sourcePort = 2283;
        destination = "192.168.100.21:2283";
        proto = "tcp";
      }
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-immich" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Persistent dirs for immich state (local SSD)
    system.activationScripts.immich-dirs = ''
      mkdir -p /var/lib/immich-data
      chmod 700 /var/lib/immich-data
    '';

    containers.immich = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.20";
      localAddress = "192.168.100.21";

      # GPU for hardware transcoding
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
      ];

      # Make sure upload, library, encoded-video, backups dirs exist on the nas!
      bindMounts = {
        "/var/lib/immich" = {
          hostPath = "/var/lib/immich-data";
          isReadOnly = false;
        };

        "/var/lib/immich/upload" = {
          hostPath = "${immichMountPoint}/upload";
          isReadOnly = false;
        };

        "/var/lib/immich/library" = {
          hostPath = "${immichMountPoint}/library";
          isReadOnly = false;
        };

        "/var/lib/immich/encoded-video" = {
          hostPath = "${immichMountPoint}/encoded-video";
          isReadOnly = false;
        };

        "/var/lib/immich/backups" = {
          hostPath = "${immichMountPoint}/backups";
          isReadOnly = false;
        };

        "/mnt/photos" = {
          hostPath = "${homesMountPoint}/${cfg.photosSubdir}";
          isReadOnly = true;
        };

        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
      };

      config = { config, pkgs, lib, ... }: {
        # NAS read-only group (existing photos)
        users.groups.homes-ro.gid = homesRoGid;

        # NAS read-write group (uploads, encoded-video, backups)
        users.groups.immich-rw.gid = immichRwGid;

        # GPU group
        users.groups.render.gid = renderGid;

        services.immich = {
          enable = true;
          port = 2283;
          host = "0.0.0.0";
          openFirewall = true;
          mediaLocation = "/var/lib/immich";
          accelerationDevices = [ "/dev/dri/renderD128" ];

        };

        # Add immich user to all required groups
        users.users.immich.extraGroups = [
          "homes-ro" # read existing photos from NAS
          "immich-rw" # write uploads/encoded-video/backups on NAS
          "render" # GPU access
          "video" # GPU access
        ];

        networking = {
          nameservers = [ "1.1.1.1" "8.8.8.8" ];
          firewall = {
            enable = true;
            allowedTCPPorts = [ 2283 ];
          };
        };

        # Hardening
        systemd.services.immich-server = {
          environment = { LIBVA_DRIVER_NAME = "radeonsi"; };
          serviceConfig = {
            SupplementaryGroups = [ "homes-ro" "immich-rw" "render" ];
            ProtectHome = lib.mkForce true;
            PrivateTmp = lib.mkForce true;
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
