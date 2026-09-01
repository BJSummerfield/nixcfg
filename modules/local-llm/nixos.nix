# Once the container is running log into it with
# sudo nixos-container root-login local-llm
# tailscale up --hostname=llm --advertise-tags=tag:solo-node
# tailscale serve --bg --https=443 8080                              # Open WebUI
# tailscale serve --bg --https=8443 http://192.168.100.24:5800       # vLLM, for pi
#
# The 8443 target is the HOST, not localhost: vLLM is a podman container managed
# by systemd on redtruck, and this guest only fronts it. `tailscale serve` state
# lives on the node rather than in nix, so it does not follow a rebuild - after
# switching away from llama-swap (which listened on 8081 in here) the 8443 rule
# must be re-run once by hand, and re-run again if this is ever reverted.

{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.local-llm;

  nvidiaEnabled = config.mine.system.nvidia.enable;
  # cuda.enable is separate from nvidia.enable - it needs the Blackwell card and
  # the nvidia container toolkit, which a non-GPU host has no business enabling.
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
  # docs/local-llm-review-2026-09-01/04-change-and-keep.md (C1).
  #
  # 0.28.0 also turns prefix caching on by default for Mamba models (#50991),
  # which makes our --enable-prefix-caching redundant. It stays explicit: it
  # documents intent and survives a future default flip in either direction.
  vllmImage = "docker.io/vllm/vllm-openai:v0.28.0";
  # CUDA talks to these directly instead of /dev/dri
  nvidiaDevices = [
    "/dev/nvidia0"
    "/dev/nvidiactl"
    "/dev/nvidia-uvm"
    "/dev/nvidia-uvm-tools"
    "/dev/nvidia-modeset"
  ];

  # The container's veth endpoints, named once because three things have to
  # agree: where vLLM publishes on the host, how the guest reaches it (Open
  # WebUI and `tailscale serve`), and the metrics scrape below.
  hostAddress = "192.168.100.24";
  localAddress = "192.168.100.25";
  # Fixed, where llama-swap assigned one dynamically from 5800 upward. That
  # dynamic port was the whole reason vLLM's /metrics was unreachable without
  # a proxy in front of it - see docs/local-llm-review-2026-09-01/06.
  vllmPort = 5800;
  vllmEndpoint = "http://${hostAddress}:${toString vllmPort}";

  catalog = import ./models.nix;
  allAliasNames = builtins.concatMap (n: builtins.attrNames (catalog.models.${n}.aliases or { })) (
    builtins.attrNames catalog.models
  );
  weightsOf = import ./weights.nix { inherit lib pkgs; };
  vllmService = import ./vllm-service.nix {
    inherit
      lib
      pkgs
      catalog
      weightsOf
      vllmImage
      hostAddress
      ;
    port = vllmPort;
  };

  # Snapshot vLLM's own metrics. Retention lives inside the script rather than
  # in a tmpfiles rule so that the guard, the write and the prune are one
  # readable ordering — see the comments there for why prune comes first.
  metricsScrape = pkgs.writeShellScript "vllm-metrics-scrape" ''
    set -uo pipefail
    dir=/var/lib/local-llm/metrics
    find=${pkgs.findutils}/bin/find

    mkdir -p "$dir"

    # Prune first, ahead of the scrape. Retention has to be unconditional:
    # files only accumulate while the engine is up, so a prune that ran only on
    # successful scrapes would freeze the last 14 days on disk for however long
    # the engine stayed stopped, and only resume when it came back.
    "$find" "$dir" -name '*.prom.gz' -mtime +14 -delete
    # Separately, because a *.prom.gz pattern does not match *.prom.gz.tmp and
    # would leave one orphan behind forever per scrape killed mid-write. A live
    # scrape finishes in seconds, so an hour old means abandoned.
    "$find" "$dir" -name '*.prom.gz.tmp' -mmin +60 -delete

    # Straight at the engine. Under llama-swap this needed a /running guard
    # first, because /upstream/<model>/metrics was a lazy-start proxy route and
    # scraping it blind would boot a 22 GiB model just to read a gauge. With a
    # plain systemd unit there is nothing to summon: -sf fails and we skip.
    out="$dir/$(date -u +%Y%m%dT%H%M%SZ).prom.gz"
    if ${lib.getExe pkgs.curl} -sf --max-time 10 "${vllmEndpoint}/metrics" \
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
    cuda.enable = lib.mkEnableOption "Serve vLLM NVFP4 models from a host podman container (needs the CUDA/Blackwell card)";
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
        # Under llama-swap a second entry meant a second model it could swap to.
        # There is no swapper now: one systemd unit serves catalog.default on one
        # port, and the weights alone are ~22GiB of a 31GiB card, so a second
        # resident model does not fit regardless. Without this assertion a second
        # entry would silently appear in pi's model list (settings.nix derives it
        # from `enabled`) and 404 at vLLM, which is a confusing way to find out.
        assertion = builtins.length catalog.enabled == 1;
        message = "local-llm: models.nix `enabled` must name exactly one model - a single GPU serves one, and there is no swapper to pick between them";
      }
      {
        assertion = builtins.all (a: !(catalog.models ? ${a})) allAliasNames;
        message = "local-llm: models.nix alias names must not collide with model names (a colliding alias would be passed twice to --served-model-name and duplicate its id in the clients)";
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

    # 8080 (Open WebUI) only. 8081 was llama-swap's OpenAI endpoint; the engine
    # is not proxied through the guest any more, and reaching it from off-box
    # goes through the tailnet rather than a LAN port forward.
    networking.firewall.allowedTCPPorts = [ 8080 ];
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-local-llm" ];
      externalInterface = config.mine.system.externalInterface;
      forwardPorts = [
        {
          sourcePort = 8080;
          destination = "${localAddress}:8080";
          proto = "tcp";
        }
      ];
    };

    system.activationScripts.local-llm-dirs = ''
      mkdir -p /var/lib/local-llm/vllm-cache /var/lib/local-llm/metrics
      chmod 755 /var/lib/local-llm
    '';

    # vLLM runs on the HOST via podman - nesting a container runtime inside the
    # nspawn container would mean cgroup and overlayfs misery.
    #
    # It used to be *launched* from inside the guest: llama-swap ran the podman
    # client against a bind-mounted /run/podman/podman.sock, which is
    # root-equivalent on the host. That socket had exactly one consumer, so
    # replacing llama-swap with a host systemd unit removed the grant rather
    # than relocating it - the bind mount is gone from containers.local-llm
    # below, and nothing in the guest can reach host podman any more.
    #
    # We also stop opting the API socket into sockets.target. Note that does
    # not switch it off: nixpkgs' own podman module still activates
    # podman.socket. The security property that changed is the bind mount, not
    # the listener - a host-local root-owned socket is ordinary podman.
    virtualisation.podman.enable = lib.mkIf cudaEnabled true;
    hardware.nvidia-container-toolkit.enable = lib.mkIf cudaEnabled true;
    systemd.services.vllm = lib.mkIf cudaEnabled vllmService;
    # One port, not the old 5800-5999 range: llama-swap's PORT macro assigned
    # dynamically, so the range had to cover every port it might pick. The
    # guest reaches the engine here - Open WebUI directly, and `tailscale serve`
    # fronting the tailnet.
    networking.firewall.interfaces."ve-local-llm" = lib.mkIf cudaEnabled {
      allowedTCPPorts = [ vllmPort ];
    };

    # The declarative half of the image pin: bumping vllmImage re-runs this
    # on the next switch. The vllm unit itself never pulls (--pull=never) so a
    # missing image fails fast instead of downloading 10+ GB inside that unit's
    # start timeout.
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
    # recently nothing read them - they sat behind llama-swap's dynamically
    # assigned port. On a fixed port they are simply there, one curl away, both
    # from redtruck and (via `tailscale serve`) from the tailnet.
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
    # in the script, unconditionally, ahead of the scrape itself.
    systemd.services.vllm-metrics-scrape = lib.mkIf cudaEnabled {
      description = "snapshot vLLM's Prometheus metrics";
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
      );

      config = import ./container.nix { inherit vllmEndpoint; };
    };
  };
}
