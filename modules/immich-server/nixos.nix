{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.immich-server;
  nasCfg = config.mine.system.nas;
  renderGid = config.mine.system.renderGroupGid;
  homesRwGid = nasCfg.shares.homes.rwGid;
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
        assertion = homesRwGid != null;
        message = "NAS homes share must have rwGid defined to use immich-server";
      }
      {
        assertion = immichRwGid != null;
        message = "NAS immich share must have rwGid defined to use immich-server";
      }
    ];

    mine.system.nas.shares.homes = {
      enable = true;
      persistent = true;
    };

    mine.system.nas.shares.immich = {
      enable = true;
      persistent = true;
    };

    hardware.graphics = {
      enable = true;
      extraPackages = [
        pkgs.intel-media-driver
        pkgs.vpl-gpu-rt
      ];
    };

    users.groups.render.gid = renderGid;

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-immich" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.immich-dirs = ''
      mkdir -p /var/lib/immich-data
      chmod 700 /var/lib/immich-data
    '';

    mine.system.tailscale-container.immich = {
      enable = true;
      hostname = "immich";
      serve = {
        enable = true;
        port = 2283;
        afterService = "immich-server.service";
      };
    };

    containers.immich = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.20";
      localAddress = "192.168.100.21";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
      ];

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

      config = { lib, ... }: {
        users.groups.homes-rw.gid = homesRwGid;
        users.groups.immich-rw.gid = immichRwGid;
        users.groups.render.gid = renderGid;

        services.immich = {
          enable = true;
          port = 2283;
          host = "0.0.0.0";
          openFirewall = false;
          mediaLocation = "/var/lib/immich";
          accelerationDevices = [ "/dev/dri/renderD128" ];
        };

        users.users.immich.extraGroups = [
          "homes-rw"
          "immich-rw"
          "render"
          "video"
        ];

        networking.firewall.enable = true;

        systemd.services.immich-server = {
          environment = { LIBVA_DRIVER_NAME = "iHD"; };
          serviceConfig = {
            SupplementaryGroups = [ "homes-rw" "immich-rw" "render" ];
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
