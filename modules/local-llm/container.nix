# The nspawn guest — everything here runs inside the container.
{ llamaSwapConfig, cudaEnabled }:
{
  config,
  pkgs,
  lib,
  ...
}:
{
  # podman CLI for debugging the host socket; llama-swap uses the store path.
  environment.systemPackages = lib.optionals cudaEnabled [ pkgs.podman ];
  # also at /etc/llama-swap.yaml for reading the effective config.
  environment.etc."llama-swap.yaml".source = llamaSwapConfig;

  services.tailscale.enable = true;
  systemd.services.llama-swap = {
    description = "llama-swap (model-swapping proxy for vLLM)";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];
    # podman client needs a homedir for config lookup
    environment.HOME = "/var/lib/llama-swap";
    serviceConfig = {
      ExecStart = ''
        ${pkgs.llama-swap}/bin/llama-swap \
          --listen 0.0.0.0:8081 \
          --config ${llamaSwapConfig}
      '';
      Restart = "on-failure";
      RestartSec = 10;
      # Container-root: podman socket is root-owned, unprivileged user gains nothing.
      StateDirectory = "llama-swap";
    };
  };

  services.open-webui = {
    enable = true;
    host = "0.0.0.0";
    port = 8080;
    environment = {
      OPENAI_API_BASE_URL = "http://127.0.0.1:8081/v1";
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
      allowedTCPPorts = [
        8080
        8081
      ];
      trustedInterfaces = [ "tailscale0" ];
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "open-webui" ];

  system.stateVersion = "24.11";
}
