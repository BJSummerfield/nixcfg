# Bring-up:
#   sudo nixos-container root-login jellyfin
#   tailscale up --hostname=jellyfin --advertise-tags=tag:solo-node
#   tailscale serve --bg 8096

{
  lib,
  config,
  pkgs,
  ...
}:
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

    users.groups.render.gid = renderGid;

    networking.firewall.allowedTCPPorts = [ 8096 ];
    networking.nat.forwardPorts = [
      {
        sourcePort = 8096;
        destination = "192.168.100.11:8096";
        proto = "tcp";
      }
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-jellyfin" ];
      externalInterface = config.mine.system.externalInterface;
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/nixos-containers/jellyfin/var/lib/private/jellyfin" ];
      stopContainers = [ "jellyfin" ];
    };

    system.activationScripts.jellyfin-dirs = ''
      mkdir -p /var/lib/tailscale-jellyfin
      chmod 700 /var/lib/tailscale-jellyfin
    '';

    containers.jellyfin = {

      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.10";
      localAddress = "192.168.100.11";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
        {
          modifier = "rwm";
          node = "/dev/dri/renderD128";
        }
      ];

      bindMounts = {
        "/media" = {
          hostPath = mediaMountPoint;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-jellyfin";
          isReadOnly = false;
        };
      };
      config =
        {
          config,
          lib,
          ...
        }:
        {
          users.groups.media-ro.gid = mediaRoGid;

          users.groups.render.gid = renderGid;

          services.tailscale.enable = true;

          services.jellyfin.enable = true;
          networking = {
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              allowedTCPPorts = [ 8096 ];
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          systemd.services.jellyfin = {
            environment = {
              LIBVA_DRIVER_NAME = "iHD";
            };
            serviceConfig = {
              DynamicUser = lib.mkForce true;
              SupplementaryGroups = [
                "media-ro"
                "render"
              ];
              StateDirectory = "jellyfin";
              CacheDirectory = "jellyfin";
              ProtectHome = lib.mkForce true;
              PrivateTmp = lib.mkForce true;
              ProtectControlGroups = lib.mkForce true;
              ProtectKernelTunables = lib.mkForce true;
              NoNewPrivileges = lib.mkForce true;
              RestrictAddressFamilies = lib.mkForce [
                "AF_UNIX"
                "AF_INET"
                "AF_INET6"
                "AF_NETLINK"
              ];
            };
          };
          system.stateVersion = "24.11";
        };
    };
  };
}
