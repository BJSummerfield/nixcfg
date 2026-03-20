{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.jellyfin-server;
  nasCfg = config.mine.system.nas;
  renderGid = config.mine.system.renderGroupGid;
  mediaRoGid = nasCfg.shares.media.roGid;
  mediaMountPoint = nasCfg.shares.media.mountPoint;
in
{
  options.mine.system.jellyfin-server = {
    enable = lib.mkEnableOption "Enable Jellyfin-server container";
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = renderGid != null;
        message = "mine.system.renderGroupGid must be set to use jellyfin-server";
      }
      {
        assertion = mediaRoGid != null;
        message = "NAS media share must have rwGid defined to use jellyfin-server";
      }
    ];

    # Enable the NAS media share as persistent
    mine.system.nas.shares.media = {
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

    # for hardware acceleration
    users.groups.render.gid = renderGid;

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
      externalInterface = config.mine.system.externalInterface;
    };

    mine.system.tailscale-container.jellyfin = {
      enable = true;
      hostname = "jellyfin";
      serve = {
        enable = true;
        port = 8096;
        afterService = "jellyfin.service";
      };
    };

    containers.jellyfin = {
      # Mapping container to a local port
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";

      # renderD128 for hardware acceleration
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
      ];

      bindMounts = {
        "/media" = {
          hostPath = mediaMountPoint;
        };
        # GPU passthrough for hardware acceleration
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        # GPU drivers from host - avoids duplicating hardware.graphics in container
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
      };

      config = { lib, ... }: {
        # container level gid for the media group and nfs mount
        users.groups.media-ro.gid = mediaRoGid;

        # for hardware acceleration
        users.groups.render.gid = renderGid;

        services.jellyfin.enable = true;

        networking = {
          # needed to get the dns for https nameserver
          firewall = {
            enable = true;
            # Lan access
            allowedTCPPorts = [ 8096 ];
          };
        };

        # Hardening the container
        systemd.services.jellyfin = {
          environment = { LIBVA_DRIVER_NAME = "iHD"; };
          serviceConfig = {
            DynamicUser = lib.mkForce true;
            SupplementaryGroups = [ "media-ro" "render" ];
            StateDirectory = "jellyfin";
            CacheDirectory = "jellyfin";
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
