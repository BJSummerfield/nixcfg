# Required: Create the Tailscale OAuth key file before enabling:
#   echo "tskey-client-..." | sudo tee /etc/tailscale-solo-node-key
#   sudo chmod 600 /etc/tailscale-solo-node-key
#
# First login get the ServerAdmin privilege key.
# sudo nixos-container run teamspeak -- journalctl -u teamspeak3-server --no-page | grep token

{ lib, config, ... }:
{
  options.mine.system.teamspeak-server = {
    enable = lib.mkEnableOption "Enable TeamSpeak server container";
  };

  config = lib.mkIf config.mine.system.teamspeak-server.enable {
    # Make needed directories
    system.activationScripts.teamspeak-dirs = ''
      mkdir -p /var/lib/tailscale-teamspeak
      chmod 700 /var/lib/tailscale-teamspeak
    '';


    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-teamspeak" ];
      externalInterface = config.mine.system.externalInterface;
    };

    containers.teamspeak = {

      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.12";
      localAddress = "192.168.100.13";

      # tun is needed for tailscale network
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # persists the tailscale node
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-teamspeak";
          isReadOnly = false;
        };
        # where to find the auth key
        "/run/tailscale-auth" = {
          hostPath = "/etc/tailscale-solo-node-key";
          isReadOnly = true;
        };
      };

      config = { config, lib, ... }: {
        nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
          "teamspeak-server"
        ];

        systemd.services.tailscaled-autoconnect = {
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          startLimitBurst = 5;
          startLimitIntervalSec = 60;
          serviceConfig = {
            Type = lib.mkForce "simple";
            SuccessExitStatus = "1";
            Restart = "on-failure";
            RestartSec = 5;
          };
        };

        # sets the tailscale params
        services.tailscale = {
          enable = true;
          authKeyFile = "/run/tailscale-auth";
          extraUpFlags = [
            "--hostname=teamspeak"
            "--advertise-tags=tag:solo-node"
          ];
        };

        services.teamspeak3.enable = true;

        networking = {
          nameservers = [ "1.1.1.1" "8.8.8.8" ];
          firewall = {
            enable = true;
            # allows connection from other tailscale devices
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        # Hardening the container
        systemd.services.teamspeak3-server = {
          serviceConfig = {
            DynamicUser = lib.mkForce true;
            StateDirectory = "teamspeak3-server";
            CacheDirectory = "teamspeak3-server";
            LogsDirectory = "teamspeak3-server";
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
