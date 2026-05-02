# sudo nixos-container root-login terraria
# tailscale up --hostname=terraria --advertise-tags=tag:solo-node

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.terraria-server;
in
{
  options.mine.system.terraria-server = {
    enable = lib.mkEnableOption "Enable Terraria dedicated server container";

    port = lib.mkOption {
      type = lib.types.port;
      default = 7777;
    };

    password = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "World-readable in the Nix store. Fine for casual use.";
    };

    maxPlayers = lib.mkOption {
      type = lib.types.ints.between 1 255;
      default = 12;
    };
  };

  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-terraria" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.terraria-dirs = ''
      mkdir -p /var/lib/terraria-data
      chmod 700 /var/lib/terraria-data
      mkdir -p /var/lib/tailscale-terraria
      chmod 700 /var/lib/tailscale-terraria
    '';

    containers.terraria = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.30";
      localAddress = "192.168.100.31";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
      ];

      bindMounts = {
        "/var/lib/terraria" = {
          hostPath = "/var/lib/terraria-data";
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-terraria";
          isReadOnly = false;
        };
      };

      config = { config, lib, ... }: {
        nixpkgs.config.allowUnfreePredicate = pkg:
          builtins.elem (lib.getName pkg) [ "terraria-server" ];

        services.terraria = {
          enable = true;
          port = cfg.port;
          maxPlayers = cfg.maxPlayers;
          password = cfg.password;
          openFirewall = false;
          autoCreatedWorldSize = "large";
          worldPath = "/var/lib/terraria/worlds/beefcake.wld";
        };

        services.tailscale.enable = true;

        networking = {
          nameservers = [ "9.9.9.9" "1.1.1.1" ];
          firewall = {
            enable = true;
            trustedInterfaces = [ "tailscale0" ];
            allowedUDPPorts = [ config.services.tailscale.port ];
          };
        };

        system.stateVersion = "24.11";
      };
    };
  };
}
