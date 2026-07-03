# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama.cpp endpoint for OpenCode
{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;
  qwenName = "Qwen3.6-35B-A3B-GGUF";
  qwenFile = "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";
  qwenModel = pkgs.fetchurl {
    url = "https://huggingface.co/unsloth/${qwenName}/resolve/main/${qwenFile}";
    hash = "sha256-cHpVqKQ5fs3kTeDEmdPmjBrR0kDR2mWCa0lJ0QQ/RFA=";
  };
  # Path where the model is bind-mounted inside the container.
  qwenPath = "/var/lib/models/${qwenFile}";
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
  };

  config = lib.mkIf cfg.enable {
    # AMD GPU drivers on the host
    hardware.graphics = {
      enable = true;
      extraPackages = [ pkgs.rocmPackages.clr.icd ];
    };

    # Expose web UI + llama.cpp endpoint to lan (also reachable via tailnet)
    networking.firewall.allowedTCPPorts = [ 8080 8081 ];
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        { sourcePort = 8080; destination = "192.168.100.25:8080"; proto = "tcp"; }
        { sourcePort = 8081; destination = "192.168.100.25:8081"; proto = "tcp"; }
      ];
    };

    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm/models
      chmod 755 /var/lib/local-llm
    '';

    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      hostAddress = "192.168.100.24";
      localAddress = "192.168.100.25";

      # tun for tailscale, plus AMD GPU devices for ROCm
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
        { modifier = "rwm"; node = "/dev/kfd"; }
      ];

      bindMounts = {
        "/dev/net/tun" = { hostPath = "/dev/net/tun"; isReadOnly = false; };
        "/dev/dri" = { hostPath = "/dev/dri"; isReadOnly = false; };
        "/dev/kfd" = { hostPath = "/dev/kfd"; isReadOnly = false; };
        "/run/opengl-driver" = { hostPath = "/run/opengl-driver"; isReadOnly = true; };
        "/var/lib" = { hostPath = "/var/lib/local-llm"; isReadOnly = false; };
        "/var/lib/models/${qwenFile}" = { hostPath = "${qwenModel}"; isReadOnly = true; };
      };

      config = { config, pkgs, lib, ... }:
        {
          services.tailscale.enable = true;

          # llama.cpp - serves the thinking model on :8081 (OpenAI-compatible).
          # No download service, no ConditionPathExists - the model is just
          # there (bind-mounted from the store), so llama.cpp points straight
          # at it and nothing gates on a download.
          systemd.services.llama-cpp = {
            description = "llama.cpp server (Qwen3.6-35B-A3B thinking)";
            after = [ "network.target" ];
            wantedBy = [ "multi-user.target" ];
            environment = {
              HSA_OVERRIDE_GFX_VERSION = "11.0.0";
              ROCR_VISIBLE_DEVICES = "0";
            };
            serviceConfig = {
              ExecStart = ''
                ${pkgs.llama-cpp-rocm}/bin/llama-server \
                  --host 0.0.0.0 --port 8081 \
                  -m ${qwenPath} \
                  --alias unsloth/Qwen3.6-35B-A3B \
                  --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.0 \
                  --chat-template-kwargs '{"preserve_thinking":true}' \
                  --ctx-size 131072 \
                  --n-gpu-layers 99 \
                  --flash-attn on \
              '';
              Restart = "on-failure";
              RestartSec = 10;
              DynamicUser = true;
              StateDirectory = "llama-cpp";
            };
          };

          # Open WebUI on :8080, pointed at the llama.cpp OpenAI endpoint.
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
              allowedTCPPorts = [ 8080 8081 ];
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          nixpkgs.config.allowUnfreePredicate = pkg:
            builtins.elem (lib.getName pkg) [ "open-webui" ];

          system.stateVersion = "24.11";
        };
    };
  };
}
