# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama-swap OpenAI endpoint for OpenCode

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;

  qwenMtpQ4Name = "Qwen3.6-35B-A3B-MTP-GGUF";
  qwenMtpQ4File = "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";
  qwenMtpQ4Model = pkgs.fetchurl {
    url = "https://huggingface.co/unsloth/${qwenMtpQ4Name}/resolve/main/${qwenMtpQ4File}";
    hash = "sha256-VZg8WnWhq5aYJAd7O7PeQUboKpI0BytIrU6Pkq0/6fE=";
  };
  qwenMtpQ4Path = "/var/lib/models/${qwenMtpQ4File}";


  qwen27bMtpName = "Qwen3.6-27B-MTP-GGUF";
  qwen27bMtpFile = "Qwen3.6-27B-UD-Q4_K_XL.gguf";
  qwen27bMtpModel = pkgs.fetchurl {
    url = "https://huggingface.co/unsloth/${qwen27bMtpName}/resolve/main/${qwen27bMtpFile}";
    # TODO: replace with the real hash (see notes)
    hash = "sha256-QIVmXuNtgqZyojikPw5WQ/Lw458te9XTc/DvEOz1MJU=";
  };
  qwen27bMtpPath = "/var/lib/models/${qwen27bMtpFile}";


in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
  };

  config = lib.mkIf cfg.enable {
    hardware.graphics = {
      enable = true;
      extraPackages = [ pkgs.rocmPackages.clr.icd ];
    };

    networking.firewall.allowedTCPPorts = [
      # 8080
      8081
    ];
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        # { sourcePort = 8080; destination = "192.168.100.25:8080"; proto = "tcp"; }
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
        "/var/lib/models/${qwenMtpQ4File}" = { hostPath = "${qwenMtpQ4Model}"; isReadOnly = true; };
        "/var/lib/models/${qwen27bMtpFile}" = { hostPath = "${qwen27bMtpModel}"; isReadOnly = true; };
      };

      config = { config, pkgs, lib, ... }:
        let
          llamaServer = lib.getExe' pkgs.llama-cpp-rocm "llama-server";
          llamaSwapConfig = pkgs.writeText "llama-swap.yaml" ''
            healthCheckTimeout: 300
            logLevel: info
            models:
              "Qwen3.6-35B-A3B-MTP-Q4":
                ttl: 3600
                cmd: |
                  ${llamaServer}
                  --host 127.0.0.1 --port ''${PORT}
                  -m ${qwenMtpQ4Path}
                  --alias Qwen3.6-35B-A3B-MTP-Q4
                  --temp 0.6
                  --top-p 0.95
                  --top-k 20
                  --min-p 0.0
                  --chat-template-kwargs '{"preserve_thinking":true}'
                  --ctx-size 131072
                  --cache-type-k q8_0
                  --cache-type-v q8_0
                  --spec-type draft-mtp --spec-draft-n-max 2
                  --n-cpu-moe 4
                  --n-gpu-layers 99

              "Qwen3.6-27B-MTP-Q4":
                ttl: 3600
                cmd: |
                  ${llamaServer}
                  --host 127.0.0.1 --port ''${PORT}
                  -m ${qwen27bMtpPath}
                  --alias Qwen3.6-27B-MTP-Q4
                  --temp 0.6
                  --top-p 0.95
                  --top-k 20
                  --min-p 0.0
                  --chat-template-kwargs '{"preserve_thinking":true}'
                  --cache-type-k q8_0
                  --cache-type-v q8_0
                  --ctx-size 96000
                  --spec-type draft-mtp --spec-draft-n-max 2
                  --n-gpu-layers 99
          '';
        in
        {
          services.tailscale.enable = true;
          systemd.services.llama-swap = {
            description = "llama-swap (model-swapping proxy for llama.cpp)";
            after = [ "network.target" ];
            wantedBy = [ "multi-user.target" ];
            environment = {
              HSA_OVERRIDE_GFX_VERSION = "11.0.0";
              ROCR_VISIBLE_DEVICES = "0";
            };
            serviceConfig = {
              ExecStart = ''
                ${pkgs.llama-swap}/bin/llama-swap \
                  --listen 0.0.0.0:8081 \
                  --config ${llamaSwapConfig}
              '';
              Restart = "on-failure";
              RestartSec = 10;
              DynamicUser = true;
              StateDirectory = "llama-swap";
            };
          };

          # services.open-webui = {
          #   enable = true;
          #   host = "0.0.0.0";
          #   port = 8080;
          #   environment = {
          #     OPENAI_API_BASE_URL = "http://127.0.0.1:8081/v1";
          #     OPENAI_API_KEY = "sk-no-key-required";
          #     ENABLE_OLLAMA_API = "False";
          #     WEBUI_AUTH = "True";
          #     ENABLE_SIGNUP = "True";
          #   };
          # };

          networking = {
            nameservers = [ "9.9.9.9" "1.1.1.1" ];
            enableIPv6 = false;
            firewall = {
              enable = true;
              allowedTCPPorts = [
                # 8080
                8081
              ];
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          # nixpkgs.config.allowUnfreePredicate = pkg:
          #   builtins.elem (lib.getName pkg) [ "open-webui" ];

          system.stateVersion = "24.11";
        };
    };
  };
}
