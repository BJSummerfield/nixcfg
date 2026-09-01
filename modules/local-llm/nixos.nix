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
  #
  # v0.28.0, up from v0.26.0: the first tag containing PR #51113 ("Keep mamba
  # align prefill chunks block-aligned past last_cache_position", merged
  # 2026-08-06 as c56f169d9ae4). That is the merged half of the correctness fix
  # for hybrid-Mamba prefix caching combined with MTP speculative decoding —
  # exactly what we serve: Qwen3.5-architecture model, --enable-prefix-caching,
  # --mamba-cache-mode align, --speculative-config mtp.
  #
  # The tag matters and was checked rather than assumed: #51113 merged four days
  # before v0.27.0 shipped and is still not in it, because the 0.27 release
  # branches were cut earlier (compare v0.27.1...c56f169d9ae4 -> diverged;
  # compare v0.28.0...c56f169d9ae4 -> behind, ahead=0). There is no cheaper hop.
  #
  # What this does and does not buy. #51113 closed vllm#43559, the ~20% accuracy
  # drop from prefix caching + MTP. vllm#47194 — the same interaction producing
  # tool-call leakage and needle-recall failure — is still OPEN. Our own symptom
  # is 120 malformed tool calls in 14.3h of agent work (46 with empty arguments),
  # so treat this bump as a measurable experiment, not a settled fix; the
  # baseline and the signals to compare are in
  # docs/local-llm-review-2026-09-01/05-change-and-keep.md (C1).
  #
  # 0.28.0 also turns prefix caching on by default for Mamba models (#50991),
  # which makes our --enable-prefix-caching redundant. It stays explicit: it
  # documents intent and survives a future default flip in either direction.
  vllmImage = "docker.io/vllm/vllm-openai:v0.28.0";
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

  # The container's veth endpoints. Named once because three things have to
  # agree on them: llama-swap's generated config (which publishes the vllm
  # container's port on the host end), the nspawn container definition, and the
  # metrics scrape below (which reaches llama-swap on the container end).
  hostAddress = "192.168.100.24";
  localAddress = "192.168.100.25";

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
      hostAddress
      ;
  };

  # Snapshot vLLM's own metrics. Retention lives inside the script rather than
  # in a tmpfiles rule so that the guard, the write and the prune are one
  # readable ordering — see the comments there for why prune comes first.
  metricsScrape = pkgs.writeShellScript "vllm-metrics-scrape" ''
    set -uo pipefail
    base="http://${localAddress}:8081"
    dir=/var/lib/local-llm/metrics
    curl=${lib.getExe pkgs.curl}
    find=${pkgs.findutils}/bin/find

    mkdir -p "$dir"

    # Prune first, ahead of the liveness guard below. Retention has to be
    # unconditional: scrapes only accumulate while the engine is up, so a prune
    # sitting after the guard would freeze the last 14 days on disk for however
    # long the model stayed stopped, and only resume when it came back.
    "$find" "$dir" -name '*.prom.gz' -mtime +14 -delete
    # Separately, because a *.prom.gz pattern does not match *.prom.gz.tmp and
    # would leave one orphan behind forever per scrape killed mid-write. A live
    # scrape finishes in seconds, so an hour old means abandoned.
    "$find" "$dir" -name '*.prom.gz.tmp' -mmin +60 -delete

    # llama-swap starts a model on demand and /upstream/<model>/metrics is a
    # proxied route, so scraping blind would start a 22 GiB model just to read a
    # gauge. Guard on /running: the timer observes the engine, never summons it.
    "$curl" -sf --max-time 5 "$base/running" \
      | ${lib.getExe pkgs.gnugrep} -q '"state":"ready"' || exit 0

    out="$dir/$(date -u +%Y%m%dT%H%M%SZ).prom.gz"
    if "$curl" -sf --max-time 10 "$base/upstream/${catalog.default}/metrics" \
      | ${lib.getExe pkgs.gzip} -c > "$out.tmp"; then
      mv "$out.tmp" "$out"
    else
      rm -f "$out.tmp"
    fi
  '';
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
      mkdir -p /var/lib/local-llm/vllm-cache /var/lib/local-llm/metrics
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

    # vLLM's engine metrics — KV pool size, preemption count, prefix-cache hit
    # rate, the queue/prefill/decode split, MTP acceptance per draft position —
    # are what every tuning number in models.nix actually rests on, and until
    # now nothing read them. They are reachable only through llama-swap's
    # /upstream proxy: the vllm container publishes its port on the host end of
    # the veth (192.168.100.24:58xx), not on the tailnet.
    #
    # A full scrape rather than a curated subset, because the expensive part is
    # noticing later that you did not record the field you now need. The
    # counters are cumulative since engine start and reset whenever the model
    # restarts, which is convenient: each config change gets its own clean
    # counter run to compare against the last.
    #
    # Measured, not estimated: 61,439 bytes per scrape and 6,596 gzipped. At
    # 5-minute resolution with 14-day retention that is 4,032 files and ~25 MiB
    # steady state, against ~236 MiB uncompressed. The prune that bounds it runs
    # in the script, unconditionally, ahead of the liveness guard.
    systemd.services.vllm-metrics-scrape = lib.mkIf cudaEnabled {
      description = "snapshot vLLM's Prometheus metrics through llama-swap";
      # date/mkdir/mv/rm come from here rather than from systemd's default PATH,
      # so the script behaves the same run by hand as run by the timer.
      path = [ pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = metricsScrape;
      };
    };
    systemd.timers.vllm-metrics-scrape = lib.mkIf cudaEnabled {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitActiveSec = "5min";
        # Not Persistent: a scrape missed while the box was off describes an
        # engine that was not running, so catching up on boot records nothing.
        Persistent = false;
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
