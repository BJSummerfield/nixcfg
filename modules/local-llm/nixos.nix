# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama.cpp endpoint for OpenCode

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
  };

  config = lib.mkIf cfg.enable {
    # AMD GPU drivers on the host
    hardware.graphics = {
      enable = true;
      extraPackages = [
        pkgs.rocmPackages.clr.icd
      ];
    };

    # Expose web UI + llama.cpp endpoint to lan - not needed if only
    # being accessed through tailnet
    networking.firewall.allowedTCPPorts = [ 8080 8081 ];
    networking.nat.forwardPorts = [
      {
        sourcePort = 8080;
        destination = "192.168.100.25:8080";
        proto = "tcp";
      }
      {
        sourcePort = 8081;
        destination = "192.168.100.25:8081";
        proto = "tcp";
      }
    ];

    # Allow traffic to enter the container
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Make needed directories - just the parent; systemd creates the
    # service state dirs inside it with correct (DynamicUser) ownership.
    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm
      chmod 755 /var/lib/local-llm
    '';

    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      hostAddress = "192.168.100.24";
      localAddress = "192.168.100.25";

      # tun is needed for tailscale network
      # AMD GPU devices for ROCm acceleration
      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
        { modifier = "rwm"; node = "/dev/kfd"; }
      ];

      bindMounts = {
        # needed for tailscale network
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        # GPU passthrough - render node + AMD kernel fusion driver
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/dev/kfd" = {
          hostPath = "/dev/kfd";
          isReadOnly = false;
        };
        # GPU drivers from host - avoids duplicating hardware.graphics in container
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
        # Single persistence mount. systemd creates + owns the tailscale,
        # ollama, open-webui, and llama-cpp state dirs inside with correct
        # ownership (incl. DynamicUser), and they land on the host
        # automatically. Persists: tailscale node identity, pulled models
        # (ollama + llama.cpp HF cache), webui accounts/history.
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
      };

      config = { config, pkgs, lib, ... }:
        let
          modelDir = "/var/lib/models";
          qwenFile = "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";
          qwenPath = "${modelDir}/${qwenFile}";
          qwenUrl = "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/${qwenFile}";
        in
        {
          services.tailscale.enable = true;

          systemd.services.fetch-qwen-thinking = {
            description = "Download ${qwenFile} if absent";
            wantedBy = [ "multi-user.target" ];
            after = [ "network-online.target" ]; # need network to download
            wants = [ "network-online.target" ];
            path = [ pkgs.curl pkgs.coreutils ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true; # don't re-run once the file is in place
              TimeoutStartSec = "infinity"; # 22GB over a slow link must not be reaped
            };
            script = ''
              set -euo pipefail
              mkdir -p ${modelDir}

              # Expected SHA256 of Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf (from HF).
              want=707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450

              # If the file exists and already matches, we're done.
              if [ -f "${qwenPath}" ]; then
                have=$(sha256sum "${qwenPath}" | cut -d' ' -f1)
                if [ "$have" = "$want" ]; then
                  echo "Model present and verified."
                  exit 0
                fi
                echo "Model present but hash mismatch - re-downloading."
                rm -f "${qwenPath}"
              fi

              # Download to a temp file, then atomically move into place only on success.
              tmp="${qwenPath}.part"
              curl -L --fail --retry 5 --retry-delay 10 --continue-at - \
                -o "$tmp" "${qwenUrl}"

              have=$(sha256sum "$tmp" | cut -d' ' -f1)
              if [ "$have" != "$want" ]; then
                echo "Downloaded file failed hash check (got $have)." >&2
                rm -f "$tmp"
                exit 1
              fi

              mv "$tmp" "${qwenPath}"
              echo "Model downloaded and verified."
            '';
          };

          # ---------------------------------------------------------------
          # llama.cpp - serves the Qwen3.6-35B-A3B *thinking* model as an
          # OpenAI-compatible endpoint on :8081 for OpenCode to talk to.
          # Also exposes llama.cpp's own web UI on the same port.
          # ---------------------------------------------------------------
          # don't use services.llama-cpp at all
          systemd.services.llama-cpp = {
            description = "llama.cpp server (Qwen3.6-35B-A3B thinking)";
            after = [ "network.target" "fetch-qwen-thinking.service" ];
            wants = [ "fetch-qwen-thinking.service" ];
            wantedBy = [ "multi-user.target" ];
            unitConfig.ConditionPathExists = qwenPath;
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
                  --ctx-size 32768 \
                  --n-gpu-layers 99 \
                  -ot ".ffn_.*_exps.=CPU" \
                  --flash-attn on \
                  --parallel 2
              '';
              Restart = "on-failure";
              RestartSec = 10;
              DynamicUser = true;
              StateDirectory = "llama-cpp";
            };
          };
          # ---------------------------------------------------------------
          # Open WebUI - chat UI on :8080. Point it at BOTH backends:
          #   - ollama (native)  for casual chat
          #   - llama.cpp (:8081) OpenAI endpoint for the thinking model
          # ---------------------------------------------------------------
          services.open-webui = {
            enable = true;
            host = "0.0.0.0";
            port = 8080;
            environment = {

              # Register the llama.cpp thinking model as an OpenAI provider
              # so it shows up in the WebUI model picker too.
              OPENAI_API_BASE_URL = "http://127.0.0.1:8081/v1";
              OPENAI_API_KEY = "sk-no-key-required";

              ENABLE_OLLAMA_API = "False"; # no ollama in this setup
              # Auth ON - each person gets their own account + chat history
              WEBUI_AUTH = "True";
              # First account created becomes admin. Flip to "False" and
              # rebuild once your users are registered to lock signups.
              ENABLE_SIGNUP = "True";
            };
          };

          networking = {
            # needed to get the dns for https nameserver
            nameservers = [ "9.9.9.9" "1.1.1.1" ];
            firewall = {
              enable = true;
              # Lan access: WebUI + llama.cpp endpoint
              allowedTCPPorts = [ 8080 8081 ];
              # allows connection from other tailscale devices
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          nixpkgs.config.allowUnfreePredicate = pkg:
            builtins.elem (lib.getName pkg) [ "open-webui" ];

          environment.systemPackages = with pkgs; [
            amdgpu_top
          ];

          system.stateVersion = "24.11";
        };
    };
  };
}
