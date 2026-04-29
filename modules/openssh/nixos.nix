{ lib, config, ... }:
let
  cfg = config.mine.system.openssh;
  externalInterface = config.mine.system.externalInterface;
in
{
  options.mine.system.openssh = {
    inbound = {
      enable = lib.mkEnableOption "Accept incoming SSH connections (sshd)";
      openOnExternalInterface = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Allow SSH on mine.system.externalInterface.
          Use for stationary machines on a trusted LAN.
        '';
      };
    };
    outbound = {
      enable = lib.mkEnableOption "Outgoing SSH client config and agent";
    };
  };
  config = lib.mkMerge [
    (lib.mkIf cfg.inbound.enable {
      assertions = [
        {
          assertion = !cfg.inbound.openOnExternalInterface || externalInterface != null;
          message = ''
            mine.system.openssh.inbound.openOnExternalInterface is enabled,
            but mine.system.externalInterface is not set. Set externalInterface
            to the name of the public NIC.
          '';
        }
      ];

      services.openssh = {
        enable = true;
        openFirewall = false;
        settings = {
          PermitRootLogin = "no";
          PasswordAuthentication = false;
          KbdInteractiveAuthentication = false;
        };
      };
      networking.firewall.interfaces = lib.mkIf cfg.inbound.openOnExternalInterface {
        ${externalInterface}.allowedTCPPorts = [ 22 ];
      };
    })
    (lib.mkIf cfg.outbound.enable {
      programs.ssh = {
        extraConfig = ''
          AddKeysToAgent yes
        '';
      };
    })
  ];
}
