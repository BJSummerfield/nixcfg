# NixOS configuration for the devbox container. `inputs` is the host
# flake's inputs; tailnetHostname and tailscaleTags come from the host
# module's options.
{ inputs, tailnetHostname, tailscaleTags }:
{ pkgs, lib, ... }:
{
  networking = {
    # container has no host resolv.conf; needed for the tailscale
    # control plane and for agents fetching from the network
    nameservers = [ "9.9.9.9" "1.1.1.1" ];
    firewall = {
      enable = true;
      trustedInterfaces = [ "tailscale0" ];
    };
  };

  system.stateVersion = "26.05";
}
