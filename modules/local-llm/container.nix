# The nspawn guest — everything here runs inside the container.
#
# vLLM does not run here. It is a podman container on the HOST, managed by
# systemd there; this guest is the tailnet front door and the Open WebUI host,
# and reaches the engine over the veth at `vllmEndpoint`.
{ vllmEndpoint }:
{
  config,
  lib,
  ...
}:
{
  services.tailscale.enable = true;

  services.open-webui = {
    enable = true;
    host = "0.0.0.0";
    port = 8080;
    environment = {
      OPENAI_API_BASE_URL = "${vllmEndpoint}/v1";
      OPENAI_API_KEY = "sk-no-key-required";
      ENABLE_OLLAMA_API = "False";
      WEBUI_AUTH = "True";
      ENABLE_SIGNUP = "True";
    };
  };

  networking = {
    nameservers = [
      "9.9.9.9"
      "1.1.1.1"
    ];
    enableIPv6 = false;
    firewall = {
      enable = true;
      # 8081 was llama-swap. Nothing listens in this guest but Open WebUI now;
      # the tailnet endpoint is served by `tailscale serve` proxying straight
      # to the host, which needs no port open here.
      allowedTCPPorts = [ 8080 ];
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "open-webui" ];

  system.stateVersion = "24.11";
}
