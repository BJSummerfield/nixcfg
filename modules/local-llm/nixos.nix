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

  hostAddress = "192.168.100.24";
  localAddress = "192.168.100.25";
  enginePort = 5800;
  metricsPort = 5801;

  catalog = import ./models.nix;
  artifactOf = import ./artifact.nix { inherit pkgs; };
  ninfer = pkgs.callPackage ./ninfer-package.nix { };

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
        assertion = builtins.all (n: builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]*" n != null) (
          builtins.attrNames catalog.models
        );
        message = "local-llm: model names must match [A-Za-z0-9][A-Za-z0-9_.-]* (--served-model-name)";
      }
      {
        assertion = cudaEnabled -> ninferAvailable;
        message = "local-llm: models.nix has no `ninfer` block for ${catalog.default} (it needs its own .ninfer artifact)";
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
      mkdir -p /var/lib/local-llm/ninfer
      chmod 755 /var/lib/local-llm
    '';

    mine.allowedUnfree = lib.mkIf cudaEnabled [
      "libnvvm"
      "cuda_crt"
      "cuda_cccl"
      "cuda_nvtx"
      "cuda_cudart"
      "cuda_nvcc"
    ];

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
      ++ lib.optionals cudaEnabled gpuDevices;

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
      // lib.optionalAttrs cudaEnabled (
        gpuMounts
        // {
          "/run/opengl-driver" = {
            hostPath = "/run/opengl-driver";
            isReadOnly = true;
          };
        }
      );

      config = {
        imports = [ (import ./container.nix) ];
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
