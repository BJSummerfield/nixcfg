# Catalog entry → the systemd unit that serves it.
#
# Replaces the llama-swap YAML generator. The catalog→flags mapping is the same
# one that lived in llama-swap.nix; what went away is the swapping scaffolding
# around it (proxy:, cmd:/cmdStop:, healthCheckTimeout, logLevel, the ${PORT}
# macro, and the alias/useModelName rewrite).
{
  lib,
  pkgs,
  catalog,
  weightsOf,
  vllmImage,
  hostAddress,
  port,
}:
let
  name = catalog.default;
  m = catalog.models.${name};

  num = builtins.toJSON;
  containerName = "vllm-${lib.toLower name}";
  podman = lib.getExe' pkgs.podman "podman";
  endpoint = "http://${hostAddress}:${toString port}";

  # vLLM answers to every name listed here, so an alias is a real served name
  # rather than the fiction it was under llama-swap - that rewrote an alias
  # back via useModelName, so vLLM never saw it. Space-separated, which is why
  # the name-charset assertion in nixos.nix is load-bearing.
  servedNames = lib.concatStringsSep " " ([ name ] ++ builtins.attrNames (m.aliases or { }));

  # Multimodal admission, and the memory profile that goes with it.
  #
  # No `vision` block means every modality limit is 0 and vLLM logs "running in
  # text-only mode" - the encoder is not loaded at all, so it costs nothing.
  #
  # With one, the width/height are *profiling hints*: upstream is explicit that
  # they "affect memory profiling only. They shape the dummy inputs used to
  # compute reserved activation sizes", and that "encoder cache size is
  # determined by the actual inputs at runtime and is not limited by these
  # hints". So this stops the startup OOM the old text-only comment recorded -
  # profiling a worst-case image on this architecture means ViT attention over
  # ~62k patches at 16MP - but it is NOT a runtime cap. A client that posts a
  # 40MP photo is still a 40MP forward pass. Resize before sending.
  #
  # Measured on redtruck 2026-09-01, both runs on the good activation roll:
  #   text-only  weights 21.11 GiB, activation 1.03 GiB, pool 185,122 (1.41x)
  #   1x1280x800 weights 21.97 GiB, activation 1.05 GiB, pool 163,502 (1.25x)
  # The tower costs 0.86 GiB of weights; the hints cost 0.02 GiB of activation.
  # Net -21,620 tokens of KV pool, -11.7%. Video stays 0: it is many frames per
  # item and would not fit.
  mmLimit =
    if m ? vision then
      "'{\"image\": {\"count\": ${num m.vision.maxImages}, \"width\": ${num m.vision.width}, \"height\": ${num m.vision.height}}, \"video\": 0}'"
    else
      "'{\"image\":0,\"video\":0}'";

  # One flag per line, in vLLM's documented order.
  vllmArgs = [
    "--model /model"
    "--served-model-name ${servedNames}"
    "--kv-cache-dtype ${m.vllm.kvCacheDtype}"
    "--max-model-len ${num m.maxModelLen}"
    "--gpu-memory-utilization ${num m.vllm.gpuMemoryUtilization}"
    "--limit-mm-per-prompt ${mmLimit}"
    "--max-num-batched-tokens ${num m.vllm.maxNumBatchedTokens}"
    "--max-num-seqs ${num m.vllm.maxNumSeqs}"
    "--enable-auto-tool-choice"
    "--tool-call-parser ${m.vllm.toolCallParser}"
    "--reasoning-parser ${m.vllm.reasoningParser}"
    # Pins the served default to the catalog's sampling block, so the value a
    # client omits is the one the model card documents rather than whatever
    # the repo's generation_config happens to ship.
    "--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
    "--speculative-config '{\"method\": \"mtp\", \"num_speculative_tokens\": ${num m.vllm.speculativeTokens}}'"
  ]
  # Hybrid-attention prefix caching: vLLM auto-disables it for this
  # architecture, so it needs the explicit opt-in, and the linear-attention
  # (mamba) state must cache at the same block granularity as the attention
  # KV. `align` is vLLM's default mode when prefix caching is on for mamba
  # hybrids; we pass it explicitly to pin the behavior. `align` asserts
  # block_size <= max_num_batched_tokens (live block size 1600), so the
  # chunk must stay >= the "Setting attention block size to N tokens"
  # startup line. Per-model opt-in; the rationale and the measured-working
  # A/B plan live in models.nix.
  ++ lib.optionals (m.vllm.enablePrefixCaching or false) [
    "--enable-prefix-caching"
    "--mamba-cache-mode align"
  ];

  podmanArgs = [
    "run --rm --replace --pull=never"
    "--name ${containerName}"
    # systemd already captures this container's stdout as the unit's journal
    # stream, because podman runs attached in the foreground. Podman's default
    # driver on a systemd host is journald, so leaving it would store a second
    # copy of every vLLM line under CONTAINER_NAME= - the journal was carrying
    # each startup line twice. `none` keeps `journalctl -u vllm` and drops the
    # duplicate; `podman logs` stops working, which is redundant here anyway.
    "--log-driver=none"
    "--device nvidia.com/gpu=all"
    "--ipc=host"
    "-e HF_HUB_OFFLINE=1"
    "-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
    # Bound to the veth host end, not 0.0.0.0: the only clients are inside the
    # nspawn container (Open WebUI directly, and tailscale serve fronting the
    # tailnet), plus redtruck itself.
    "-p ${hostAddress}:${toString port}:8000"
    "-v ${weightsOf name m}:/model:ro"
    # the model dir is a store symlink farm, so the targets must be reachable
    "-v /nix/store:/nix/store:ro"
    "-v /var/lib/local-llm/vllm-cache:/root/.cache"
    vllmImage
  ]
  ++ vllmArgs;

  start = pkgs.writeShellScript "vllm-start" ''
    exec ${podman} ${lib.concatStringsSep " \\\n  " podmanArgs}
  '';

  # llama-swap held a client request through a cold start (healthCheckTimeout:
  # 900). A systemd unit cannot do that - what it can do is refuse to report
  # itself started until vLLM actually serves, so `systemctl start vllm` means
  # something and other units can order after it. Clients during the window
  # still get connection-refused and must retry; that is the one behavioural
  # regression from dropping the proxy.
  waitHealthy = pkgs.writeShellScript "vllm-wait-healthy" ''
    set -u
    for _ in $(${lib.getExe' pkgs.coreutils "seq"} 1 900); do
      # Bail the instant the engine is gone rather than polling a corpse. An
      # earlier version looped the full 900s regardless, so a podman failure
      # that took one second to happen took three minutes to report - and the
      # unit sat in `activating` the whole time, which reads as progress. It
      # also let Restart=on-failure overlap two engine startups, and a profile
      # run that races another engine's teardown mis-sizes the KV pool.
      ${lib.getExe' pkgs.coreutils "kill"} -0 "$MAINPID" 2>/dev/null || {
        echo "vllm exited before becoming healthy" >&2
        exit 1
      }
      ${lib.getExe pkgs.curl} -sf --max-time 2 ${endpoint}/health >/dev/null && exit 0
      ${lib.getExe' pkgs.coreutils "sleep"} 1
    done
    echo "vllm did not become healthy within 900s" >&2
    exit 1
  '';
in
{
  description = "vLLM OpenAI server (${name})";
  # Tied to the nspawn container, not to multi-user.target. The bind address is
  # the host end of that container's veth, so it does not exist until the
  # container is up - and containers.local-llm.autoStart is false, so at boot it
  # is not. Started against multi-user.target this failed every time with
  # "bind: cannot assign requested address" and only recovered by accident, when
  # Restart=on-failure happened to fire after the container was started by hand.
  #
  # Under llama-swap the constraint was satisfied implicitly: the launcher ran
  # *inside* the container, so the container was necessarily up. Moving the
  # launch to the host dropped that guarantee without replacing it. wantedBy
  # starts vLLM with the container, partOf stops it with the container, after
  # orders it - and manual-start stays manual, matching autoStart = false.
  wantedBy = [ "container@local-llm.service" ];
  partOf = [ "container@local-llm.service" ];
  after = [
    "container@local-llm.service"
    "network-online.target"
    "vllm-image-pull.service"
  ];
  wants = [ "network-online.target" ];
  serviceConfig = {
    # Type=exec, not simple: systemd waits for the exec itself to succeed, then
    # ExecStartPost gates "started" on the engine actually answering /health.
    Type = "exec";
    ExecStart = start;
    ExecStartPost = waitHealthy;
    ExecStop = "${podman} stop -t 30 ${containerName}";
    # A cold start is minutes (weights load, CUDA graph capture, KV profiling),
    # and TimeoutStartSec covers ExecStartPost, so it has to clear the health
    # poll's own 900s ceiling.
    TimeoutStartSec = 960;
    TimeoutStopSec = 60;
    Restart = "on-failure";
    RestartSec = 10;
  };
}
