# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=8443 http://127.0.0.1:5800                  # the engine
# tailscale serve --bg --https=8443 --set-path /ops http://127.0.0.1:5801  # ninfer-metrics
# The serve rules must be re-run by hand after a rebuild; they do not follow nix.
#
# Nothing starts at boot: `nixos-container start local-llm` brings the container
# and the engine up together (cuda.autoStart = false to start the engine by hand).
#
# A throwaway A/B needs no rebuild: one NINFER_EXTRA_ARGS=... line in
# /var/lib/local-llm/ninfer.env, then restart the unit inside the container.
# Later flags win, except the booleans (--lm-head-draft, --vision).
#
# engine = "vllm" runs on the host in podman; its serve rule then points at
# http://192.168.100.24:5800.

{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.local-llm;

  nvidiaEnabled = config.mine.system.nvidia.enable;
  cudaEnabled = cfg.cuda.enable;
  engine = cfg.cuda.engine;
  ninferSelected = cudaEnabled && engine == "ninfer";
  vllmSelected = cudaEnabled && engine == "vllm";

  vllmImage = "docker.io/vllm/vllm-openai:nightly-dc36fcce902a63eab06c1b93a5c4a5ee178a0c56";
  hostAddress = "192.168.100.24";
  localAddress = "192.168.100.25";
  enginePort = 5800;
  metricsPort = 5801;

  catalog = import ./models.nix;
  allAliasNames = builtins.concatMap (n: builtins.attrNames (catalog.models.${n}.aliases or { })) (
    builtins.attrNames catalog.models
  );
  weightsOf = import ./weights.nix { inherit lib pkgs; };
  artifactOf = import ./artifact.nix { inherit pkgs; };
  ninfer = pkgs.callPackage ./ninfer-package.nix { };

  vllmService = import ./vllm-service.nix {
    inherit
      lib
      pkgs
      catalog
      weightsOf
      vllmImage
      hostAddress
      ;
    port = enginePort;
  };

  ninferAvailable = catalog.models.${catalog.default} ? ninfer;

  gpuNodes = [
    "/dev/nvidia0"
    "/dev/nvidiactl"
    "/dev/nvidia-modeset"
    "/dev/nvidia-uvm"
    "/dev/nvidia-uvm-tools"
  ];
  gpuDevices = map (node: {
    modifier = "rwm";
    inherit node;
  }) gpuNodes;
  gpuMounts = lib.genAttrs gpuNodes (node: {
    hostPath = node;
    isReadOnly = false;
  });
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
    cuda = {
      enable = lib.mkEnableOption "Serve NVFP4 models on the CUDA/Blackwell card";
      engine = lib.mkOption {
        type = lib.types.enum [
          "ninfer"
          "vllm"
        ];
        default = "ninfer";
        description = "Which engine is built: NInfer inside the container, or vLLM on the host in podman.";
      };
      autoStart = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Start the engine whenever its container starts. The container itself never autostarts, so the card stays idle at boot either way.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cudaEnabled -> nvidiaEnabled;
        message = "mine.system.local-llm.cuda.enable requires mine.system.nvidia.enable";
      }
      {
        assertion = builtins.all (n: catalog.models ? ${n}) catalog.enabled;
        message = "local-llm: models.nix `enabled` names a model that does not exist";
      }
      {
        assertion = builtins.elem catalog.default catalog.enabled;
        message = "local-llm: models.nix `default` must be listed in `enabled`";
      }
      {
        assertion = builtins.length catalog.enabled == 1;
        message = "local-llm: models.nix `enabled` must name exactly one model - a single GPU serves one, and there is no swapper to pick between them";
      }
      {
        assertion = builtins.all (a: !(catalog.models ? ${a})) allAliasNames;
        message = "local-llm: models.nix alias names must not collide with model names (a colliding alias would be passed twice to --served-model-name and duplicate its id in the clients)";
      }
      {
        assertion = builtins.all (n: builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]*" n != null) (
          builtins.attrNames catalog.models ++ allAliasNames
        );
        message = "local-llm: model and alias names must match [A-Za-z0-9][A-Za-z0-9_.-]* (podman container names and --served-model-name)";
      }
      {
        assertion =
          ninferSelected
          -> builtins.all (
            n:
            builtins.all (a: lib.hasPrefix "${n}-" a) (builtins.attrNames (catalog.models.${n}.aliases or { }))
          ) catalog.enabled;
        message = "local-llm: NInfer serves one --model-id and is patched to accept only `<model-id>-<suffix>` besides it, so every alias of the enabled model must start with `<model>-`";
      }
      {
        assertion = ninferSelected -> ninferAvailable;
        message = "local-llm: cuda.engine = \"ninfer\" but models.nix has no `ninfer` block for ${catalog.default} (it needs its own .ninfer artifact; vLLM's safetensors will not load)";
      }
    ];

    hardware.graphics = {
      enable = true;
      extraPackages = lib.optionals (!nvidiaEnabled) [ pkgs.rocmPackages.clr.icd ];
    };

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm/vllm-cache /var/lib/local-llm/ninfer
      chmod 755 /var/lib/local-llm
    '';

    mine.allowedUnfree = lib.mkIf ninferSelected [
      "libnvvm"
      "cuda_crt"
      "cuda_cccl"
      "cuda_nvtx"
      "cuda_cudart"
      "cuda_nvcc"
    ];

    virtualisation.podman.enable = lib.mkIf vllmSelected true;
    hardware.nvidia-container-toolkit.enable = lib.mkIf vllmSelected true;

    systemd.services.vllm = lib.mkIf vllmSelected (
      vllmService // lib.optionalAttrs cfg.cuda.autoStart { wantedBy = [ "multi-user.target" ]; }
    );

    networking.firewall.interfaces."ve-local-llm" = lib.mkIf vllmSelected {
      allowedTCPPorts = [ enginePort ];
    };

    systemd.services.vllm-image-pull = lib.mkIf vllmSelected {
      description = "pull the pinned vLLM OCI image";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "exec";
        ExecStart = "${pkgs.podman}/bin/podman pull ${vllmImage}";
      };
    };

    containers.local-llm = {
      autoStart = false;
      privateNetwork = true;
      inherit hostAddress localAddress;

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ]
      ++ lib.optionals ninferSelected gpuDevices;

      bindMounts = {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
      }
      // lib.optionalAttrs ninferSelected (
        gpuMounts
        // {
          "/run/opengl-driver" = {
            hostPath = "/run/opengl-driver";
            isReadOnly = true;
          };
        }
      );

      config = {
        imports = [ (import ./container.nix { engine = if ninferSelected then "ninfer" else "none"; }) ];
        _module.args = {
          inherit
            catalog
            artifactOf
            ninfer
            enginePort
            metricsPort
            ;
          inherit (cfg.cuda) autoStart;
        };
      };
    };
  };
}
