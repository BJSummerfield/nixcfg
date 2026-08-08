# NixOS configuration for the devbox container. `inputs` is the host
# flake's inputs; tailnetHostname and tailscaleTags come from the host
# module's options.
{ inputs, tailnetHostname, tailscaleTags }:
{ config, pkgs, lib, ... }:
{
  services.tailscale = {
    enable = true;
    # Joins on first boot with no interactive `tailscale up`. The tag must
    # exist in the ACL policy and the key must be issued for it, or the
    # join fails silently from the container's point of view.
    authKeyFile = "/run/secrets/devbox-tailscale-authkey";
    extraUpFlags = [
      "--hostname=devbox"
      "--advertise-tags=${lib.concatStringsSep "," tailscaleTags}"
    ];
  };

  # `tailscale serve` config lives in tailscaled's own state, so this is
  # idempotent across boots. It runs after the node has joined, otherwise
  # serve has no identity to attach the proxy to.
  systemd.services.devbox-tailscale-serve = {
    description = "Publish the paseo daemon on the tailnet";
    after = [ "tailscaled-autoconnect.service" ];
    wants = [ "tailscaled-autoconnect.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${lib.getExe pkgs.tailscale} serve --bg 6767
    '';
  };

  networking = {
    # container has no host resolv.conf; needed for the tailscale
    # control plane and for agents fetching from the network
    nameservers = [ "9.9.9.9" "1.1.1.1" ];
    firewall = {
      enable = true;
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  system.stateVersion = "26.05";
}
