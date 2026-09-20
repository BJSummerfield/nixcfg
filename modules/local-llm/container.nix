{
  config,
  ...
}:
# The container exists only to own the `llm` tailnet node: its `tailscale serve
# --https=8443` is the address pi and every other client talks to, and it has to
# survive whichever engine is running on the host behind it.
{
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
