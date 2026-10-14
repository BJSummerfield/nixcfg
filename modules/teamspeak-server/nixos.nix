# sudo nixos-container root-login teamspeak
# sudo nixos-container run teamspeak -- journalctl -u teamspeak3-server --no-page | grep token

{ lib, config, ... }:
let
  cfg = config.mine.system.teamspeak-server;
in
{
  options.mine.system.teamspeak-server = {
    enable = lib.mkEnableOption "Enable TeamSpeak server container";
    publicAccess = lib.mkEnableOption "Enable public access (port forwarding)";
  };

  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-teamspeak" ];
      externalInterface = config.mine.system.externalInterface;
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/nixos-containers/teamspeak/var/lib/private/teamspeak3-server" ];
      stopContainers = [ "teamspeak" ];
    };

    networking.firewall = lib.mkIf cfg.publicAccess {
      allowedUDPPorts = [ 9987 ];
      allowedTCPPorts = [ 30033 ];
    };

    containers.teamspeak = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.12";
      localAddress = "192.168.100.13";

      forwardPorts = lib.mkIf cfg.publicAccess [
        {
          protocol = "udp";
          hostPort = 9987;
          containerPort = 9987;
        }
        {
          protocol = "tcp";
          hostPort = 30033;
          containerPort = 30033;
        }
      ];

      config = { lib, ... }: {
        nixpkgs.config.allowUnfreePredicate =
          pkg:
          builtins.elem (lib.getName pkg) [
            "teamspeak-server"
          ];

        services.teamspeak3.enable = true;

        networking = {
          nameservers = [
            "9.9.9.9"
            "1.1.1.1"
          ];
          firewall = {
            enable = true;

            allowedUDPPorts = lib.optionals cfg.publicAccess [ 9987 ];

            allowedTCPPorts = lib.optionals cfg.publicAccess [ 30033 ];
          };
        };

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
