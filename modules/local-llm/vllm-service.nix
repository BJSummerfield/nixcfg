# Catalog entry → the systemd unit that serves it.
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

  # Space-separated, which is why the name-charset assertion in nixos.nix is
  # load-bearing.
  servedNames = lib.concatStringsSep " " ([ name ] ++ builtins.attrNames (m.aliases or { }));

  # No `vision` block means every modality limit is 0 and the encoder is never
  # loaded. With one, width/height are memory-profiling hints, NOT a runtime cap
  # - a client that posts a 40MP photo is still a 40MP forward pass. Video stays
  # 0: many frames per item, would not fit. Measurements in
  # docs/local-llm-review-2026-09-01/02-vllm-and-model.md.
  mmLimit =
    if m ? vision then
      "'{\"image\": {\"count\": ${num m.vision.maxImages}, \"width\": ${num m.vision.width}, \"height\": ${num m.vision.height}}, \"video\": 0}'"
    else
      "'{\"image\":0,\"video\":0}'";

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
    # So the value a client omits is the one the model card documents, not
    # whatever the repo's generation_config ships.
    "--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
  ]
  # vLLM auto-disables prefix caching for this architecture, so the opt-in is
  # explicit. `align` caches the linear-attention (mamba) state at the same
  # block granularity as the attention KV, and asserts
  # block_size <= max_num_batched_tokens - so maxNumBatchedTokens must stay >=
  # the "Setting attention block size to N tokens" startup line.
  ++ lib.optionals (m.vllm.enablePrefixCaching or false) [
    "--enable-prefix-caching"
    "--mamba-cache-mode align"
  ];

  podmanArgs = [
    "run --rm --replace --pull=never"
    "--name ${containerName}"
    # systemd already captures this container's stdout as the unit's journal
    # stream; podman's journald default would store a second copy of every line.
    "--log-driver=none"
    "--device nvidia.com/gpu=all"
    "--ipc=host"
    "-e HF_HUB_OFFLINE=1"
    "-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
    # The host end of the container's veth, not 0.0.0.0: every client is inside
    # the nspawn container, plus redtruck itself.
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

  # Gates "started" on the engine actually serving, so `systemctl start vllm`
  # means something and other units can order after it. Clients during the
  # window get connection-refused and must retry.
  waitHealthy = pkgs.writeShellScript "vllm-wait-healthy" ''
    set -u
    for _ in $(${lib.getExe' pkgs.coreutils "seq"} 1 900); do
      # Bail the instant the engine is gone rather than polling a corpse: a
      # podman failure would otherwise sit in `activating` for the full 900s,
      # and Restart=on-failure could overlap two engine startups - a KV
      # profiling run that races another engine's teardown mis-sizes the pool.
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
  # Tied to the nspawn container, not multi-user.target: the bind address is the
  # host end of that container's veth and does not exist until the container is
  # up. wantedBy starts vLLM with the container, partOf stops it with the
  # container, after orders it - and manual-start stays manual, matching
  # containers.local-llm.autoStart = false.
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
    # ExecStartPost gates "started" on /health.
    Type = "exec";
    ExecStart = start;
    ExecStartPost = waitHealthy;
    ExecStop = "${podman} stop -t 30 ${containerName}";
    # A cold start is minutes, and TimeoutStartSec covers ExecStartPost, so it
    # has to clear the health poll's own 900s ceiling.
    TimeoutStartSec = 960;
    TimeoutStopSec = 60;
    Restart = "on-failure";
    RestartSec = 10;
  };
}
