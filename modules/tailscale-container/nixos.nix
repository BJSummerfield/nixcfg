# Reusable Tailscale-in-container module.
#
# Usage (from a service module):
#
#   mine.system.tailscale-container.jellyfin = {
#     enable = true;
#     hostname = "jellyfin";
#     serve = {
#       enable = true;
#       port = 8096;
#       afterService = "jellyfin.service";
#     };
#   };
#
# Required: Create the Tailscale OAuth key file before enabling:
#   echo "tskey-client-..." | sudo tee /etc/tailscale-solo-node-key
#   sudo chmod 600 /etc/tailscale-solo-node-key

{ lib, config, ... }:
let
  cfg = config.mine.system.tailscale-container;
  enabledContainers = lib.filterAttrs (_: v: v.enable) cfg;
in
{
  options.mine.system.tailscale-container = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule {
      options = {
        enable = lib.mkEnableOption "Tailscale networking for this container";

        hostname = lib.mkOption {
          type = lib.types.str;
          description = "Tailscale hostname for this container";
        };

        tag = lib.mkOption {
          type = lib.types.str;
          default = "solo-node";
          description = "Tailscale ACL tag (without the tag: prefix)";
        };

        authKeyFile = lib.mkOption {
          type = lib.types.str;
          default = "/etc/tailscale-solo-node-key";
          description = "Host path to the Tailscale auth key file";
        };

        serve = {
          enable = lib.mkEnableOption "Tailscale serve reverse proxy";

          port = lib.mkOption {
            type = lib.types.port;
            description = "Local port to expose via tailscale serve";
          };

          afterService = lib.mkOption {
            type = lib.types.str;
            default = "";
            description = "Systemd service to wait for before starting tailscale serve (e.g. jellyfin.service)";
          };
        };
      };
    });
    default = { };
    description = "Per-container Tailscale configuration. The attrset key must match the container name.";
  };

  config = lib.mkIf (enabledContainers != { }) (lib.mkMerge (lib.mapAttrsToList
    (name: tsCfg: {

      system.activationScripts."tailscale-${name}-dirs" = ''
        mkdir -p /var/lib/tailscale-${name}
        chmod 700 /var/lib/tailscale-${name}
      '';

      containers.${name} = {
        allowedDevices = [
          { modifier = "rwm"; node = "/dev/net/tun"; }
        ];

        bindMounts = {
          "/dev/net/tun" = {
            hostPath = "/dev/net/tun";
            isReadOnly = false;
          };
          "/var/lib/tailscale" = {
            hostPath = "/var/lib/tailscale-${name}";
            isReadOnly = false;
          };
          "/run/tailscale-auth" = {
            hostPath = tsCfg.authKeyFile;
            isReadOnly = true;
          };
        };

        config = { config, pkgs, lib, ... }: {

          systemd.services.tailscaled-autoconnect.serviceConfig = {
            Type = lib.mkForce "simple";
            Restart = "on-failure";
            RestartSec = 5;
          };

          services.tailscale = {
            enable = true;
            authKeyFile = "/run/tailscale-auth";
            extraUpFlags = [
              "--hostname=${tsCfg.hostname}"
              "--advertise-tags=tag:${tsCfg.tag}"
            ];
          };

          networking = {
            nameservers = [ "1.1.1.1" "8.8.8.8" ];
            firewall = {
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          systemd.services.tailscale-serve = lib.mkIf tsCfg.serve.enable {
            description = "Tailscale Serve for ${tsCfg.hostname}";
            after = [ "tailscaled-autoconnect.service" ]
              ++ lib.optional (tsCfg.serve.afterService != "") tsCfg.serve.afterService;
            wants = [ "tailscaled-autoconnect.service" ]
              ++ lib.optional (tsCfg.serve.afterService != "") tsCfg.serve.afterService;
            wantedBy = [ "multi-user.target" ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              Restart = "on-failure";
              RestartSec = 10;
            };
            script = ''
              ${pkgs.tailscale}/bin/tailscale serve --bg ${toString tsCfg.serve.port}
            '';
          };
        };
      };

    })
    enabledContainers));
}
