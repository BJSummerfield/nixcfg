# Required: Create the Tailscale OAuth key file before enabling:
#   echo "tskey-client-..." | sudo tee /etc/tailscale-solo-node-key
#   sudo chmod 600 /etc/tailscale-solo-node-key
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

    # for hardware acceleration
    users.groups.render.gid = renderGid;

    # Allow traffic to enter the container
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-immich" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Make needed directories
    system.activationScripts.immich-dirs = ''
      mkdir -p /var/lib/immich-data
      chmod 700 /var/lib/immich-data
      mkdir -p /var/lib/tailscale-immich
      chmod 700 /var/lib/tailscale-immich
    '';

    containers.immich = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.20";
      localAddress = "192.168.100.21";

      # tun is needed for tailscale network
      # renderD128 for hardware acceleration
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
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
          hostPath = homesMountPoint;
          isReadOnly = true;
        };
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
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
        # persists the tailscale node
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-immich";
          isReadOnly = false;
        };
        # where to find the auth key
        "/run/tailscale-auth" = {
          hostPath = "/etc/tailscale-solo-node-key";
          isReadOnly = true;
        };
      };

      config = { config, pkgs, lib, ... }: {
        # container level gids for nfs mounts
        users.groups.homes-rw.gid = homesRwGid;
        users.groups.immich-rw.gid = immichRwGid;

        # for hardware acceleration
        users.groups.render.gid = renderGid;

        services.immich = {
          enable = true;
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
            "--hostname=immich"
            "--advertise-tags=tag:solo-node"
          ];
        };

        # runs tailscale serve once the apps are ready
        systemd.services.tailscale-serve = {
          description = "Tailscale Serve for Immich";
          after = [ "tailscaled-autoconnect.service" "immich-server.service" ];
          wants = [ "tailscaled-autoconnect.service" "immich-server.service" ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = 10;
          };
          script = ''
            ${pkgs.tailscale}/bin/tailscale serve --bg 2283
          '';
        };

        networking = {
          # needed to get the dns for https nameserver
          nameservers = [ "1.1.1.1" "8.8.8.8" ];
          firewall = {
            enable = true;
            # allows connection from other tailscale devices
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        # Hardening the container
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
