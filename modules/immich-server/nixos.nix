# Immich photo server - LAN only
{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.immich-server;
  nasCfg = config.mine.system.nas;
  renderGid = config.mine.system.renderGroupGid;
  homeRoGid = nasCfg.shares.home.roGid;
  homeMountPoint = nasCfg.shares.home.mountPoint;
in
{
  options.mine.system.immich-server = {
    enable = lib.mkEnableOption "Enable Immich photo server container";
    photosSubdir = lib.mkOption {
      type = lib.types.str;
      default = "photos";
      description = "Subdirectory under the home NAS mount where photos live";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = renderGid != null;
        message = "mine.system.renderGroupGid must be set to use immich-server";
      }
      {
        assertion = homeRoGid != null;
        message = "NAS home share must have roGid defined to use immich-server";
      }
    ];

    # Enable the NAS home share as persistent
    mine.system.nas.shares.home = {
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

    # Persistent dirs for immich state
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

      bindMounts = {
        # NAS photos directory (read-only — add as External Library in Immich UI)
        "/mnt/photos" = {
          hostPath = "${homeMountPoint}/${cfg.photosSubdir}";
          isReadOnly = true;
        };
        # GPU passthrough
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
        # Persistent immich data (db, uploads, thumbnails, etc.)
        "/var/lib/immich" = {
          hostPath = "/var/lib/immich-data";
          isReadOnly = false;
        };
      };

      config = { config, pkgs, lib, ... }: {
        # NAS group for reading photos
        users.groups.home-ro.gid = homeRoGid;

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

        # Add immich user to the NAS and render groups
        users.users.immich.extraGroups = [ "home-ro" "render" "video" ];

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
            SupplementaryGroups = [ "home-ro" "render" ];
            ProtectHome = lib.mkForce true;
            PrivateTmp = lib.mkForce true;
            ProtectControlGroups = lib.mkForce true;
            ProtectKernelTunables = lib.mkForce true;
            NoNewPrivileges = lib.mkForce true;
            RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
          };
        };

        systemd.services.immich-machine-learning = {
          environment = { LIBVA_DRIVER_NAME = "radeonsi"; };
          serviceConfig = {
            SupplementaryGroups = [ "render" ];
          };
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
