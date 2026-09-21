{ engine }:
{ config, lib, ... }:
{
  imports = lib.optional (engine == "ninfer") ./ninfer.nix;

  services.tailscale.enable = true;

  networking = {
    nameservers = [
      "9.9.9.9"
      "1.1.1.1"
    ];
    enableIPv6 = false;
    firewall = {
      enable = true;
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  system.stateVersion = "24.11";
}
