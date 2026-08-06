# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama-swap OpenAI endpoint for OpenCode

{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;

  nvidiaEnabled = config.mine.system.nvidia.enable;
  # Gated separately from the driver: the CUDA llama.cpp build is an uncached
  # compile, so flip cuda.enable only once the card works.
  cudaEnabled = cfg.cuda.enable;

  # vLLM runs from upstream's prebuilt OCI image instead of nixpkgs: the nix
  # build compiles torch/magma/flash-attn from source (hours of nvcc that OOM
  # 32GB), and nixpkgs lags upstream releases anyway - the NVFP4 quants want
  # >= 0.25 while nixos-unstable still ships 0.16. The tag is the version
  # pin; bump it deliberately and pre-pull (see gpu-swap-steps.md).
  vllmImage = "docker.io/vllm/vllm-openai:v0.25.0";
  podmanSock = "unix:///run/podman/podman.sock";
  # CUDA talks to these directly instead of /dev/dri
  nvidiaDevices = [
    "/dev/nvidia0"
    "/dev/nvidiactl"
    "/dev/nvidia-uvm"
    "/dev/nvidia-uvm-tools"
    "/dev/nvidia-modeset"
  ];

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
    hash = "sha256-QIVmXuNtgqZyojikPw5WQ/Lw458te9XTc/DvEOz1MJU=";
  };
  qwen27bMtpPath = "/var/lib/models/${qwen27bMtpFile}";

  # NVFP4 safetensors repos (vLLM-only, needs the Blackwell card and
  # cuda.enable). Staged here so the store downloads them ahead of the
  # hardware swap. Shard hashes are the HF LFS sha256 oids.
  fetchHfFile = repo: file: hash: pkgs.fetchurl {
    url = "https://huggingface.co/unsloth/${repo}/resolve/main/${file}";
    inherit hash;
  };
  mkHfRepo = repo: files: pkgs.linkFarm repo
    (lib.mapAttrsToList (file: hash: { name = file; path = fetchHfFile repo file hash; }) files);

  qwen27bNvfp4Name = "Qwen3.6-27B-NVFP4";
  qwen27bNvfp4Model = mkHfRepo qwen27bNvfp4Name {
    "added_tokens.json" = "sha256-5fm/tkTq0TvTbdbPxBVTqTt8JkwKLhrGfQM6qCUMhTg=";
    "chat_template.jinja" = "sha256-VdSTFDP+UCt5Qibuf00gamvdQ2rJ+A632Ou0xjn56gw=";
    "config.json" = "sha256-6rZIvJEuddrPMkRSYWHhOExsIk0iRI3B4j5oYqlfujw=";
    "configuration.json" = "sha256-LURk4urQa8m8cYx4EwmtHnut7WJtZujc3ItGm6GF+vA=";
    "generation_config.json" = "sha256-0Nv2cMajcoF7L/ktXUfjEw013pw6cWS6RV/XqIJVs2I=";
    "model-00001-of-00005.safetensors" = "sha256-dCUxG+GSaujbE0Schv96A+RGXMt8a1mUV7E5JgPESGc=";
    "model-00002-of-00005.safetensors" = "sha256-Fb/z0Knrro2HahehAmZrRkYBIKljmoQFhZXywuf/Q9A=";
    "model-00003-of-00005.safetensors" = "sha256-vuSQLzB+JW+nC+5kG6UxpSdCDHebIhSBNEhMcpXzSvw=";
    "model-00004-of-00005.safetensors" = "sha256-dM16p+tgoGTRA7deVyl5YPyQttsXUGYpcLj/k7KecoM=";
    "model-00005-of-00005.safetensors" = "sha256-sbNo/lPYpoygxoiRiV4EMIfe2krR1YgPzUjGnXgFjaE=";
    "model.safetensors.index.json" = "sha256-hrTN+o0fPRRemZ03xsCH7ChBbj9P2GKzS70nncJjXG8=";
    "preprocessor_config.json" = "sha256-uZGC4JRQ8mRTUCs8M5DM42sz3IxKHz7iGAd2LhaMdKs=";
    "processor_config.json" = "sha256-ziC+mi0omAc+h/99q8DX/UU/3iHpMJqjZIWombTCkQc=";
    "special_tokens_map.json" = "sha256-zly+c39KrMdpYYCqx0MJEQG1nk3FozjZ/IpvcWqlE/c=";
    "tokenizer.json" = "sha256-GmMpzuBz9EWB8ToRGpat3xKp2aZbKsb4H6RB7Btj9ck=";
    "tokenizer_config.json" = "sha256-v9Rr2krU/rJNwW/XoHgLz99qk+jruacSuWV93Eq6akY=";
    "video_preprocessor_config.json" = "sha256-WcXJ61IYLrFMBv+xDKnv/Smtzl8jipXeI8oUo429LLE=";
    "vocab.json" = "sha256-SrDVwJYpQFS2ZEShFqILr24pmY/B+uQQ/+S2+tvFa1w=";
  };

  qwen35bNvfp4Name = "Qwen3.6-35B-A3B-NVFP4";
  qwen35bNvfp4Model = mkHfRepo qwen35bNvfp4Name {
    "chat_template.jinja" = "sha256-6E8yoj/donaJ+GiqShpWIfQRM+UaSNfz78vqKDlXQlk=";
    "config.json" = "sha256-iCS/tunnFH4+EcEq0CNquzOF5QFV98vsdDnyWX22yx4=";
    "configuration.json" = "sha256-wbCdtBkRlRMkfpuLkSxLmJcQbJsgxsrafhB9mTxUNes=";
    "generation_config.json" = "sha256-0Nv2cMajcoF7L/ktXUfjEw013pw6cWS6RV/XqIJVs2I=";
    "model-00001-of-00006.safetensors" = "sha256-rm1t+KS6yFr3nGkStzYFMxB6jeifjrEGAIyHIgP0d7E=";
    "model-00002-of-00006.safetensors" = "sha256-BxqwqnuODs+AInxr5Rv622ZtKwVmCQqyYaQ5y9dly2M=";
    "model-00003-of-00006.safetensors" = "sha256-Zn76M4UBsIJCpJX4gUgAJwuWWQWvlzFJ1ZVaUjn3/P4=";
    "model-00004-of-00006.safetensors" = "sha256-bW/CuV3PJHQf9csITBuP7zpOc0THI7bnW0K8M9jmyqc=";
    "model-00005-of-00006.safetensors" = "sha256-Hk064nurGlcriLPKcossE2i8cTZMqeHFh2OlZGP4t2A=";
    "model-00006-of-00006.safetensors" = "sha256-NFgHS0by+SqGpvitE2hKZkqt99rsfjem8a2QIp1ZzPI=";
    "model.safetensors.index.json" = "sha256-dIUZE7xQhPLu0z1EISIKMmGLlGpMzGZZKbAgHO+zetk=";
    "preprocessor_config.json" = "sha256-JyJUUKycZSmHLuGST8sJYv9WNINPgXBA9EQRgRb05RY=";
    "processor_config.json" = "sha256-2J70nOnNN/v1EBWOE8HvBj2ShkEcHskEmTLb4EhxQ7E=";
    "tokenizer.json" = "sha256-GmMpzuBz9EWB8ToRGpat3xKp2aZbKsb4H6RB7Btj9ck=";
    "tokenizer_config.json" = "sha256-eS+j8MuIsRHlTvMTTIc1MQCMTfRx0QjaF5A0JuMIqns=";
    "video_preprocessor_config.json" = "sha256-d2ivJ8H6+pzJARwdwgBn4D+JFeA7Y1BFUOEdUGaYbRM=";
    "vocab.json" = "sha256-zpm0yymD0RiAbOCot3ejWwk+IAClA+veJYUyhMnfoAM=";
  };

in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
    cuda.enable = lib.mkEnableOption "Serve models with CUDA (llama.cpp CUDA build + vLLM NVFP4 models via the upstream OCI image)";
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = cudaEnabled -> nvidiaEnabled;
      message = "mine.system.local-llm.cuda.enable requires mine.system.nvidia.enable";
    }];

    hardware.graphics = {
      enable = true;
      extraPackages = lib.optionals (!nvidiaEnabled) [ pkgs.rocmPackages.clr.icd ];
    };

    networking.firewall.allowedTCPPorts = [
      8080
      8081
    ];
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
      mkdir -p /var/lib/local-llm/models /var/lib/local-llm/vllm-cache
      chmod 755 /var/lib/local-llm
    '';

    # The vLLM model containers run on the HOST via podman - nesting a
    # container runtime inside the nspawn container would mean cgroup and
    # overlayfs misery. Inside the container llama-swap only runs the podman
    # *client* against this API socket (root-equivalent on the host; fine for
    # a single-user box, don't reuse this pattern on a shared machine).
    virtualisation.podman.enable = lib.mkIf cudaEnabled true;
    hardware.nvidia-container-toolkit.enable = lib.mkIf cudaEnabled true;
    systemd.sockets.podman = lib.mkIf cudaEnabled { wantedBy = [ "sockets.target" ]; };
    # llama-swap's PORT macro assigns upwards from 5800; the vllm containers
    # publish those ports on the host end of the veth
    networking.firewall.interfaces."ve-local-llm" = lib.mkIf cudaEnabled {
      allowedTCPPortRanges = [ { from = 5800; to = 5999; } ];
    };

    # The declarative half of the image pin: bumping vllmImage re-runs this
    # on the next switch. Model startup itself never pulls (--pull=never in
    # the llama-swap cmds) so a missing image fails fast instead of
    # downloading 10+ GB inside the health-check window.
    systemd.services.vllm-image-pull = lib.mkIf cudaEnabled {
      description = "pull the pinned vLLM OCI image";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      # Type=exec so neither boot nor nixos-rebuild switch blocks on the
      # download; it continues in the background (watch with
      # journalctl -u vllm-image-pull -f). A model started mid-download
      # fails fast until the image lands.
      serviceConfig = {
        Type = "exec";
        ExecStart = "${pkgs.podman}/bin/podman pull ${vllmImage}";
      };
    };

    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      hostAddress = "192.168.100.24";
      localAddress = "192.168.100.25";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
        { modifier = "rwm"; node = "/dev/dri/renderD128"; }
      ] ++ lib.optionals nvidiaEnabled (map (node: { modifier = "rwm"; inherit node; }) nvidiaDevices);

      bindMounts = {
        "/dev/net/tun" = { hostPath = "/dev/net/tun"; isReadOnly = false; };
        "/dev/dri" = { hostPath = "/dev/dri"; isReadOnly = false; };
        "/run/opengl-driver" = { hostPath = "/run/opengl-driver"; isReadOnly = true; };
        "/var/lib" = { hostPath = "/var/lib/local-llm"; isReadOnly = false; };
        "/var/lib/models/${qwenMtpQ4File}" = { hostPath = "${qwenMtpQ4Model}"; isReadOnly = true; };
        "/var/lib/models/${qwen27bMtpFile}" = { hostPath = "${qwen27bMtpModel}"; isReadOnly = true; };
        "/var/lib/models/${qwen27bNvfp4Name}" = { hostPath = "${qwen27bNvfp4Model}"; isReadOnly = true; };
        "/var/lib/models/${qwen35bNvfp4Name}" = { hostPath = "${qwen35bNvfp4Model}"; isReadOnly = true; };
      } // lib.optionalAttrs nvidiaEnabled
        (lib.genAttrs nvidiaDevices (node: { hostPath = node; isReadOnly = false; }))
      // lib.optionalAttrs cudaEnabled {
        "/run/podman/podman.sock" = { hostPath = "/run/podman/podman.sock"; isReadOnly = false; };
      };

      config = { config, pkgs, lib, ... }:
        let
          llamaServer = lib.getExe'
            (if cudaEnabled
             then pkgs.llama-cpp.override { cudaSupport = true; }
             else pkgs.llama-cpp-vulkan)
            "llama-server";
          # Drives HOST podman over the bind-mounted API socket; vLLM itself
          # is the upstream OCI image (vllmImage above), not a nix build.
          podmanCli = "${lib.getExe' pkgs.podman "podman"} --url ${podmanSock}";
          llamaSwapConfig = pkgs.writeText "llama-swap.yaml" (''
            healthCheckTimeout: 900
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
                  --ctx-size 98304
                  --flash-attn on
                  --cache-type-k q8_0
                  --cache-type-v q8_0
                  --spec-type draft-mtp --spec-draft-n-max 2
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
                  --flash-attn on
                  --cache-type-k q8_0
                  --cache-type-v q8_0
                  --ctx-size 131072
                  --spec-type draft-mtp --spec-draft-n-max 2
                  --n-gpu-layers 99
          '' + lib.optionalString cudaEnabled ''
            # NVFP4 safetensors models, served by the upstream vLLM image via
            # HOST podman (needs the Blackwell card). The container runs only
            # while its model is loaded: llama-swap podman-runs it on demand,
            # podman-stops it on swap/ttl, --rm cleans up. The model dir is a
            # store symlink farm, hence the extra read-only /nix/store mount.
            # --pull=never so a forgotten pre-pull fails fast instead of
            # silently downloading 10+ GB inside the health-check window.
            # Per Unsloth's guide: let vLLM auto-pick the quant backend (never
            # force marlin by hand) and switch kv-cache to bf16 if fp8 shows
            # instability. Sampling defaults come from each repo's
            # generation_config.json. max-model-len is conservative; raise once
            # real VRAM use is measured.
            # These are VL models but served text-only (limit-mm 0): weights
            # alone are ~22GiB of the 31GiB card, and the vision-encoder
            # profiling buffers plus a 2048-token activation peak OOMed
            # startup. If VRAM is still tight, the next knob is dropping the
            # speculative-config line (frees the MTP drafter).
              "Qwen3.6-27B-NVFP4":
                ttl: 3600
                proxy: http://192.168.100.24:''${PORT}
                cmd: |
                  ${podmanCli} run --rm --replace --pull=never
                  --name vllm-qwen27b-nvfp4
                  --device nvidia.com/gpu=all
                  --ipc=host
                  -e HF_HUB_OFFLINE=1
                  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
                  -p 192.168.100.24:''${PORT}:8000
                  -v ${qwen27bNvfp4Model}:/model:ro
                  -v /nix/store:/nix/store:ro
                  -v /var/lib/local-llm/vllm-cache:/root/.cache
                  ${vllmImage}
                  --model /model
                  --served-model-name Qwen3.6-27B-NVFP4
                  --kv-cache-dtype fp8
                  # measured pool: 123,207 tokens (first successful boot);
                  # if a future config change shrinks it below this, step
                  # back to 114688
                  --max-model-len 122880
                  --gpu-memory-utilization 0.92
                  --limit-mm-per-prompt '{"image":0,"video":0}'
                  --max-num-batched-tokens 1024
                  --max-num-seqs 2
                  --enable-auto-tool-choice
                  --tool-call-parser hermes
                  --reasoning-parser qwen3
                  --speculative-config '{"method": "mtp", "num_speculative_tokens": 2}'
                cmdStop: ${podmanCli} stop -t 30 vllm-qwen27b-nvfp4

              "Qwen3.6-35B-A3B-NVFP4":
                ttl: 3600
                proxy: http://192.168.100.24:''${PORT}
                cmd: |
                  ${podmanCli} run --rm --replace --pull=never
                  --name vllm-qwen35b-nvfp4
                  --device nvidia.com/gpu=all
                  --ipc=host
                  -e HF_HUB_OFFLINE=1
                  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
                  -p 192.168.100.24:''${PORT}:8000
                  -v ${qwen35bNvfp4Model}:/model:ro
                  -v /nix/store:/nix/store:ro
                  -v /var/lib/local-llm/vllm-cache:/root/.cache
                  ${vllmImage}
                  --model /model
                  --served-model-name Qwen3.6-35B-A3B-NVFP4
                  --kv-cache-dtype fp8
                  --max-model-len 32768
                  --gpu-memory-utilization 0.95
                  --limit-mm-per-prompt '{"image":0,"video":0}'
                  --max-num-batched-tokens 1024
                  --max-num-seqs 2
                  --enable-auto-tool-choice
                  --tool-call-parser hermes
                  --reasoning-parser qwen3
                  --speculative-config '{"method": "mtp", "num_speculative_tokens": 2}'
                cmdStop: ${podmanCli} stop -t 30 vllm-qwen35b-nvfp4
          '');
        in
        {
          # the podman CLI for poking the host socket when debugging;
          # llama-swap itself invokes it by absolute store path
          environment.systemPackages = lib.optionals cudaEnabled [ pkgs.podman ];

          services.tailscale.enable = true;
          systemd.services.llama-swap = {
            description = "llama-swap (model-swapping proxy for llama.cpp)";
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
            let name = lib.getName pkg; in
            builtins.elem name [ "open-webui" ]
            # the CUDA toolchain is dozens of separately-named unfree packages
            || (cudaEnabled && (lib.hasPrefix "cuda" name
              || lib.hasPrefix "libcu" name
              || lib.hasPrefix "libnv" name));

          system.stateVersion = "24.11";
        };
    };
  };
}
