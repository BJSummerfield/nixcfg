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
      allowedTCPPorts = [ 8080 ];
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "open-webui" ];

  system.stateVersion = "24.11";
}
