# Bring-up:
#   sudo nixos-container root-login hass
#   tailscale up --hostname=ha --advertise-tags=tag:solo-node
#   tailscale serve --bg 8123

{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.system.home-assistant;

  dataDir = "/var/lib/hass-data";
  mosquittoDir = "/var/lib/hass-mosquitto";
  tailscaleDir = "/var/lib/tailscale-hass";

  localAddress = "192.168.100.35";
  mqttPort = 1883;
in
{
  options.mine.system.home-assistant = {
    enable = lib.mkEnableOption "Home Assistant and Mosquitto container";

    valetudoMqttPasswordFile = lib.mkOption {
      type = lib.types.str;
      description = ''
        Host path to the clear-text MQTT password of the valetudo user (e.g.
        config.sops.secrets.hass-mqtt-valetudo-pw.path), bind-mounted
        read-only into the container. A string rather than a path, so a Nix
        path literal can't copy the secret into the store.
      '';
      example = "/run/secrets/hass-mqtt-valetudo-pw";
    };

    homeassistantMqttPasswordFile = lib.mkOption {
      type = lib.types.str;
      description = ''
        Host path to the clear-text MQTT password of the homeassistant user
        (e.g. config.sops.secrets.hass-mqtt-homeassistant-pw.path),
        bind-mounted read-only into the container. A string rather than a
        path, so a Nix path literal can't copy the secret into the store.
      '';
      example = "/run/secrets/hass-mqtt-homeassistant-pw";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-hass" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        {
          sourcePort = mqttPort;
          destination = "${localAddress}:${toString mqttPort}";
          proto = "tcp";
        }
      ];
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ dataDir ];
      stopContainers = [ "hass" ];
    };

    system.activationScripts.hass-dirs = ''
      mkdir -p ${dataDir}
      chmod 700 ${dataDir}
      mkdir -p ${mosquittoDir}
      chmod 700 ${mosquittoDir}
      mkdir -p ${tailscaleDir}
      chmod 700 ${tailscaleDir}
    '';

    containers.hass = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.34";
      inherit localAddress;

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
        "/var/lib/hass" = {
          hostPath = dataDir;
          isReadOnly = false;
        };
        "/var/lib/mosquitto" = {
          hostPath = mosquittoDir;
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = tailscaleDir;
          isReadOnly = false;
        };
        "/run/host-secrets/hass-mqtt-valetudo-pw" = {
          hostPath = cfg.valetudoMqttPasswordFile;
          isReadOnly = true;
        };
        "/run/host-secrets/hass-mqtt-homeassistant-pw" = {
          hostPath = cfg.homeassistantMqttPasswordFile;
          isReadOnly = true;
        };
      };

      config =
        { config, ... }:
        {
          services.home-assistant = {
            enable = true;
            extraComponents = [
              "default_config"
              "esphome"
              "hue"
              "isal"
              "met"
              "mqtt"
            ];
            config = {
              default_config = { };
              http = {
                use_x_forwarded_for = true;
                trusted_proxies = [
                  "127.0.0.1"
                  "::1"
                ];
              };
              "automation ui" = "!include automations.yaml";
              "scene ui" = "!include scenes.yaml";
              "script ui" = "!include scripts.yaml";
            };
          };

          systemd.tmpfiles.rules = [
            "f ${config.services.home-assistant.configDir}/automations.yaml 0600 hass hass - []"
            "f ${config.services.home-assistant.configDir}/scenes.yaml 0600 hass hass -"
            "f ${config.services.home-assistant.configDir}/scripts.yaml 0600 hass hass -"
          ];

          services.mosquitto = {
            enable = true;
            listeners = [
              {
                address = "0.0.0.0";
                port = mqttPort;
                users = {
                  valetudo = {
                    acl = [ "readwrite #" ];
                    passwordFile = "/run/host-secrets/hass-mqtt-valetudo-pw";
                  };
                  homeassistant = {
                    acl = [ "readwrite #" ];
                    passwordFile = "/run/host-secrets/hass-mqtt-homeassistant-pw";
                  };
                };
              }
            ];
          };

          services.tailscale.enable = true;

          networking = {
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
              interfaces.eth0.allowedTCPPorts = [ mqttPort ];
            };
          };

          system.stateVersion = "26.11";
        };
    };
  };
}
