# Once the container is running log into it with
# sudo nixos-container root-login teamspeak
# tailscale up --hostname=teamspeak-public --advertise-tags=tag:solo-node 

# First login get the ServerAdmin privilege key.
# sudo nixos-container run teamspeak -- journalctl -u teamspeak3-server --no-page | grep token

{ lib, config, ... }:
let
  cfg = config.mine.system.teamspeak-server;
in
{
  options.mine.system.teamspeak-server = {
    enable = lib.mkEnableOption "Enable TeamSpeak server container";
    tailscaleAccess = lib.mkEnableOption "Enable Tailscale access (private network)";
    publicAccess = lib.mkEnableOption "Enable public access (port forwarding)";
  };

  config = lib.mkIf cfg.enable {
    system.activationScripts.teamspeak-dirs = lib.mkIf cfg.tailscaleAccess ''
      mkdir -p /var/lib/tailscale-teamspeak
      chmod 700 /var/lib/tailscale-teamspeak
    '';

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-teamspeak" ];
      externalInterface = config.mine.system.externalInterface;
    };

    networking.firewall = lib.mkIf cfg.publicAccess {
      allowedUDPPorts = [ 9987 ]; # Voice
      allowedTCPPorts = [ 30033 ]; # File Transfer
    };

    containers.teamspeak = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.12";
      localAddress = "192.168.100.13";

      forwardPorts = lib.mkIf cfg.publicAccess [
        { protocol = "udp"; hostPort = 9987; containerPort = 9987; } # Voice
        { protocol = "tcp"; hostPort = 30033; containerPort = 30033; } # File Transfer
      ];

      allowedDevices = lib.mkIf cfg.tailscaleAccess [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = lib.mkIf cfg.tailscaleAccess {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-teamspeak";
          isReadOnly = false;
        };
      };

      config = { config, lib, ... }: {
        nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
          "teamspeak-server"
        ];

        services.tailscale.enable = cfg.tailscaleAccess;
        services.teamspeak3.enable = true;

        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;

            trustedInterfaces = lib.mkIf cfg.tailscaleAccess [ "tailscale0" ];

            allowedUDPPorts = (lib.optionals cfg.tailscaleAccess [ config.services.tailscale.port ])
              ++ (lib.optionals cfg.publicAccess [ 9987 ]);

            allowedTCPPorts = lib.optionals cfg.publicAccess [ 30033 ];
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
