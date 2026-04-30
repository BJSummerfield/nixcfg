# Once the container is running log into it with
# sudo nixos-container root-login redlib
# tailscale up --hostname=redlib --advertise-tags=tag:solo-node
# tailscale serve --bg 8080

{ lib, config, ... }:
let
  cfg = config.mine.system.redlib-server;
in
{
  options.mine.system.redlib-server = {
    enable = lib.mkEnableOption "Enable Redlib (Reddit frontend) container";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Port redlib listens on inside the container";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-redlib" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.redlib-dirs = ''
      mkdir -p /var/lib/tailscale-redlib
      chmod 700 /var/lib/tailscale-redlib
    '';

    containers.redlib = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.18";
      localAddress = "192.168.100.19";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-redlib";
          isReadOnly = false;
        };
      };

      config = { config, lib, ... }: {
        services.tailscale.enable = true;

        services.redlib = {
          enable = true;
          openFirewall = false;
          address = "0.0.0.0";
          port = cfg.port;
          settings = {
            REDLIB_DEFAULT_THEME = "dark";
            REDLIB_DEFAULT_SHOW_NSFW = "off";
            REDLIB_DEFAULT_BLUR_NSFW = "on";
            REDLIB_DEFAULT_USE_HLS = "on";
          };
        };

        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        systemd.services.redlib.serviceConfig = {
          DynamicUser = lib.mkForce true;
          ProtectHome = lib.mkForce true;
          PrivateTmp = lib.mkForce true;
          ProtectControlGroups = lib.mkForce true;
          ProtectKernelTunables = lib.mkForce true;
          NoNewPrivileges = lib.mkForce true;
          RestrictAddressFamilies = lib.mkForce [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
