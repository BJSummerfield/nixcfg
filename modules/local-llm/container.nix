# The nspawn guest. Split from nixos.nix so the container boundary is a file
# boundary: everything here runs inside the container, nothing outside it.
{ llamaSwapConfig, cudaEnabled }:
{ config, pkgs, lib, ... }:
{
  # the podman CLI for poking the host socket when debugging;
  # llama-swap itself invokes it by absolute store path
  environment.systemPackages = lib.optionals cudaEnabled [ pkgs.podman ];
  # also at /etc/llama-swap.yaml so the effective config can be read
  # inside the container; same derivation the unit points at
  environment.etc."llama-swap.yaml".source = llamaSwapConfig;

  services.tailscale.enable = true;
  systemd.services.llama-swap = {
    description = "llama-swap (model-swapping proxy for vLLM)";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];
    # the podman client it spawns wants a homedir for its config lookup
    environment.HOME = "/var/lib/llama-swap";
    serviceConfig = {
      ExecStart = ''
        ${pkgs.llama-swap}/bin/llama-swap \
          --listen 0.0.0.0:8081 \
          --config ${llamaSwapConfig}
      '';
      Restart = "on-failure";
      RestartSec = 10;
      # Container-root, not DynamicUser: the host podman socket it
      # drives is root-owned 0660, and holding that socket is
      # root-equivalent anyway, so the unprivileged user bought
      # nothing but "permission denied".
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
    nameservers = [ "9.9.9.9" "1.1.1.1" ];
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

  nixpkgs.config.allowUnfreePredicate = pkg:
    builtins.elem (lib.getName pkg) [ "open-webui" ];

  system.stateVersion = "24.11";
}
