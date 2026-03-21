# First login get the ServerAdmin privilege key.
# sudo nixos-container run teamspeak -- journalctl -u teamspeak3-server --no-page | grep token
{ lib, config, ... }:
let
  cfg = config.mine.system.teamspeak-server;
in
{
  options.mine.system.teamspeak-server = {
    enable = lib.mkEnableOption "Enable TeamSpeak server container";
  };
  config = lib.mkMerge [
    {
      mine.system.tailscale-container.teamspeak = {
        enable = cfg.enable;
        hostname = "teamspeak";
      };
    }
    (lib.mkIf cfg.enable {
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
        config = { lib, ... }: {
          nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
            "teamspeak-server"
          ];
          services.teamspeak3.enable = true;
          networking.firewall.enable = true;
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
    })
  ];
}
