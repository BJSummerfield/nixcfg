{ lib, config, ... }:
let
  cfg = config.mine.system.tailscale;
in
{
  options.mine.system.tailscale =
    {
      enable = lib.mkEnableOption "Tailscale";

      ssh = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Whether to allow SSH connections over the tailnet interface.
          Requires mine.system.openssh.enable for an sshd to actually be listening.
        '';
      };

    };

  config = lib.mkIf cfg.enable {
    services.tailscale = {
      enable = true;
      openFirewall = true;
    };

    mine.system.openssh.inbound.enable = lib.mkIf cfg.ssh true;

    networking.firewall.interfaces = lib.mkIf cfg.ssh {
      "tailscale0".allowedTCPPorts = [ 22 ];
    };
  };
}
