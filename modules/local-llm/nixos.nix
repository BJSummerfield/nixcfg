# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080      # Open WebUI
# tailscale serve --bg --https=8443 8081     # llama-swap OpenAI endpoint for pi

{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.local-llm;

  nvidiaEnabled = config.mine.system.nvidia.enable;
  # cuda.enable is separate from nvidia.enable — podman socket grants root-equivalent host access.
  cudaEnabled = cfg.cuda.enable;

  # Use upstream OCI image — nix build OOMs on 32GB and nixpkgs lags upstream.
  # v0.26.0: first release after Qwen3.8's day-0 support announcement; the
  # 3.8 models are Qwen3.5-architecture (hybrid linear attention) and get
  # their optimized kernels here.
  vllmImage = "docker.io/vllm/vllm-openai:v0.26.0";
  podmanSock = "unix:///run/podman/podman.sock";
  # Drives HOST podman over the bind-mounted API socket; vLLM itself
  # is the upstream OCI image (vllmImage above), not a nix build.
  podmanCli = "${lib.getExe' pkgs.podman "podman"} --url ${podmanSock}";
  # CUDA talks to these directly instead of /dev/dri
  nvidiaDevices = [
    "/dev/nvidia0"
    "/dev/nvidiactl"
    "/dev/nvidia-uvm"
    "/dev/nvidia-uvm-tools"
    "/dev/nvidia-modeset"
  ];

  catalog = import ./models.nix;
  allAliasNames = builtins.concatMap (n: builtins.attrNames (catalog.models.${n}.aliases or { })) (
    builtins.attrNames catalog.models
  );
  weightsOf = import ./weights.nix { inherit lib pkgs; };
  llamaSwapConfig = import ./llama-swap.nix {
    inherit
      lib
      pkgs
      catalog
      weightsOf
      vllmImage
      podmanCli
      ;
    hostAddress = "192.168.100.24";
  };
in
{
  options.mine.system.local-llm = {
    enable = lib.mkEnableOption "Enable Local LLM container";
    cuda.enable = lib.mkEnableOption "Serve vLLM NVFP4 models over the host's podman socket (needs the CUDA/Blackwell card; grants the container root-equivalent access to the host)";
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
        assertion = builtins.all (a: !(catalog.models ? ${a})) allAliasNames;
        message = "local-llm: models.nix alias names must not collide with model names (a colliding alias shadows the model in llama-swap and duplicates its id in the clients)";
      }
      {
        # A key with a `/` (the natural mistake: HF repo ids have one) or a
        # space passes nix's attr syntax but breaks podman --name and splits
        # --served-model-name on whitespace, both only at runtime.
        assertion = builtins.all (n: builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]*" n != null) (
          builtins.attrNames catalog.models ++ allAliasNames
        );
        message = "local-llm: model and alias names must match [A-Za-z0-9][A-Za-z0-9_.-]* (podman container names and --served-model-name)";
      }
    ];

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
    };

    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm/vllm-cache
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
      allowedTCPPortRanges = [
        {
          from = 5800;
          to = 5999;
        }
      ];
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
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
        {
          modifier = "rwm";
          node = "/dev/dri/renderD128";
        }
      ]
      ++ lib.optionals nvidiaEnabled (
        map (node: {
          modifier = "rwm";
          inherit node;
        }) nvidiaDevices
      );

      bindMounts = {
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/dev/dri" = {
          hostPath = "/dev/dri";
          isReadOnly = false;
        };
        "/run/opengl-driver" = {
          hostPath = "/run/opengl-driver";
          isReadOnly = true;
        };
        "/var/lib" = {
          hostPath = "/var/lib/local-llm";
          isReadOnly = false;
        };
      }
      // lib.optionalAttrs nvidiaEnabled (
        lib.genAttrs nvidiaDevices (node: {
          hostPath = node;
          isReadOnly = false;
        })
      )
      // lib.optionalAttrs cudaEnabled {
        "/run/podman/podman.sock" = {
          hostPath = "/run/podman/podman.sock";
          isReadOnly = false;
        };
      };

      config = import ./container.nix { inherit llamaSwapConfig cudaEnabled; };
    };
  };
}
