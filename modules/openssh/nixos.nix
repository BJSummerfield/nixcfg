{ lib, config, ... }:
let
  cfg = config.mine.system.openssh;
  externalInterface = config.mine.system.externalInterface;
in
{
  options.mine.system.openssh = {
    enable = lib.mkEnableOption "OpenSSH server";

    openOnExternalInterface = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to allow SSH on the host's external (LAN/WAN) interface
        defined in mine.system.externalInterface.
        Enable for stationary machines on a trusted LAN.
        Leave false for laptops and VPSes — those rely on tailnet access only.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    services.openssh = {
      enable = true;
      openFirewall = false;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
      };
    };

    networking.firewall.interfaces = lib.mkIf cfg.openOnExternalInterface {
      ${externalInterface}.allowedTCPPorts = [ 22 ];
    };
  };
}
