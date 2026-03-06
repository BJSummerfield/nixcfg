# Required: Create the Tailscale OAuth key file before enabling:
#   echo "tskey-client-..." | sudo tee /etc/tailscale-teamspeak-key
#   sudo chmod 600 /etc/tailscale-teamspeak-key
#
# Note: teamspeak-server is unfree, ensure your nixpkgs config allows it:
#   nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
#     "teamspeak-server"
#   ];
#
# First login: check /var/log/teamspeak3-server inside the container
# for the ServerAdmin privilege key.

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
          hostPath = "/etc/tailscale-teamspeak-key";
          isReadOnly = true;
        };
      };

      config = { config, pkgs, lib, ... }: {

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
            "--hostname=teamspeaktest"
            "--advertise-tags=tag:container"
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
