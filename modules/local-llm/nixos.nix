# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=8443 http://192.168.100.24:5800       # the engine, for pi
# The 8443 rule must be re-run by hand after a rebuild; it does not follow nix.
#
# Both engines bind that same host port, and systemd Conflicts= keeps exactly
# one of them resident, so the serve rule survives switching between them:
#   llm-engine ninfer     (stops vllm, starts ninfer, waits for /health)
#   llm-engine vllm       (the reverse)
#   llm-engine stop | status
#   llm-engine args ninfer   (prints the exact command that unit runs)
# `cuda.engine` picks which one comes back after a reboot.
#
# NInfer's flags live in models.nix, but a throwaway A/B needs no rebuild: put
# one NINFER_EXTRA_ARGS=... line in /var/lib/local-llm/ninfer.env and restart
# the unit. The server takes the last value for a repeated flag, so that
# overrides models.nix - except the booleans (--lm-head-draft, --vision),
# which have no off-switch and must be turned off in models.nix.

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

  vllmImage = "docker.io/vllm/vllm-openai:nightly-dc36fcce902a63eab06c1b93a5c4a5ee178a0c56";
  hostAddress = "192.168.100.24";
  localAddress = "192.168.100.25";
  enginePort = 5800;

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
  ninferService = import ./ninfer-service.nix {
    inherit
      lib
      pkgs
      catalog
      artifactOf
      ninfer
      hostAddress
      ;
    port = enginePort;
  };

  ninferAvailable = catalog.models.${catalog.default} ? ninfer;

  llm-engine = pkgs.writeShellApplication {
    name = "llm-engine";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      usage() {
        echo "usage: llm-engine vllm|ninfer|stop|status|args [vllm|ninfer]" >&2
        exit 2
      }

      case "''${1-status}" in
        args)
          # The exact command each unit runs: copy it, edit the flags, and run
          # it by hand after `llm-engine stop` for a one-off configuration.
          systemctl cat "''${2-ninfer}.service" | ${lib.getExe' pkgs.gnugrep "grep"} -m1 ExecStart= |
            ${lib.getExe' pkgs.gnused "sed"} 's/^ExecStart=//' | ${lib.getExe' pkgs.findutils "xargs"} cat
          ;;
        vllm|ninfer)
          # Conflicts= stops the other engine as part of this transaction, so
          # the two never hold the card at once.
          systemctl start "$1.service"
          systemctl --no-pager --lines=0 status "$1.service" || true
          ;;
        stop)
          systemctl stop vllm.service ninfer.service
          ;;
        status)
          systemctl --no-pager --lines=0 status vllm.service ninfer.service || true
          ;;
        *) usage ;;
      esac
    '';
  };
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
    cuda = {
      enable = lib.mkEnableOption "Serve NVFP4 models from the host on the CUDA/Blackwell card";
      engine = lib.mkOption {
        type = lib.types.enum [
          "vllm"
          "ninfer"
        ];
        default = "vllm";
        description = ''
          Which engine starts at boot. Both units are always built; this only
          adds the wantedBy. Switch at runtime with `llm-engine <name>`, which
          does not survive a reboot.
        '';
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
        assertion = (cudaEnabled && cfg.cuda.engine == "ninfer") -> ninferAvailable;
        message = "local-llm: cuda.engine = \"ninfer\" but models.nix has no `ninfer` block for ${catalog.default} (it needs its own .ninfer artifact; vLLM's safetensors will not load)";
      }
    ];

    hardware.graphics = {
      enable = true;
      extraPackages = lib.optionals (!nvidiaEnabled) [ pkgs.rocmPackages.clr.icd ];
    };

    # The container has no published ports of its own now that Open WebUI is
    # gone - it reaches the tailnet outbound, and clients arrive over tailscale.
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm/vllm-cache /var/lib/local-llm/ninfer
      chmod 755 /var/lib/local-llm
    '';

    virtualisation.podman.enable = lib.mkIf cudaEnabled true;
    hardware.nvidia-container-toolkit.enable = lib.mkIf cudaEnabled true;

    mine.allowedUnfree = lib.mkIf cudaEnabled [
      "libnvvm"
      "cuda_crt"
      "cuda_cccl"
      "cuda_nvtx"
      "cuda_cudart"
      "cuda_nvcc"
    ];

    environment.systemPackages = lib.mkIf cudaEnabled [ llm-engine ];

    systemd.services.vllm = lib.mkIf cudaEnabled (
      vllmService // lib.optionalAttrs (cfg.cuda.engine == "vllm") { wantedBy = [ "multi-user.target" ]; }
    );
    systemd.services.ninfer = lib.mkIf (cudaEnabled && ninferAvailable) (
      ninferService
      // lib.optionalAttrs (cfg.cuda.engine == "ninfer") { wantedBy = [ "multi-user.target" ]; }
    );

    networking.firewall.interfaces."ve-local-llm" = lib.mkIf cudaEnabled {
      allowedTCPPorts = [ enginePort ];
    };

    systemd.services.vllm-image-pull = lib.mkIf cudaEnabled {
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
      ];

      bindMounts = {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
      };

      config = import ./container.nix;
    };
  };
}
