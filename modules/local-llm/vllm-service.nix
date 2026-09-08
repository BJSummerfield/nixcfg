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

  servedNames = lib.concatStringsSep " " ([ name ] ++ builtins.attrNames (m.aliases or { }));

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
    (
      if m.vllm ? kvCacheMemory then
        "--kv-cache-memory ${num m.vllm.kvCacheMemory}"
      else
        "--gpu-memory-utilization ${num m.vllm.gpuMemoryUtilization}"
    )
    "--limit-mm-per-prompt ${mmLimit}"
    "--max-num-batched-tokens ${num m.vllm.maxNumBatchedTokens}"
    "--max-num-seqs ${num m.vllm.maxNumSeqs}"
    "--enable-auto-tool-choice"
    "--tool-call-parser ${m.vllm.toolCallParser}"
    "--reasoning-parser ${m.vllm.reasoningParser}"
    "--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
  ]
  ++ lib.optionals (m.vllm ? speculativeTokens) [
    "--speculative-config '{\"method\": \"mtp\", \"num_speculative_tokens\": ${num m.vllm.speculativeTokens}, \"disable_eagle_block_drop\": true}'"
    "--no-async-scheduling"
  ]
  ++ lib.optionals (m.vllm.enablePrefixCaching or false) [
    "--enable-prefix-caching"
    "--mamba-cache-mode align"
  ];

  podmanArgs = [
    "run --rm --replace --pull=never"
    "--name ${containerName}"
    "--log-driver=none"
    "--device nvidia.com/gpu=all"
    "--ipc=host"
    "-e HF_HUB_OFFLINE=1"
    "-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
    "-p ${hostAddress}:${toString port}:8000"
    "-v ${weightsOf name m}:/model:ro"
    "-v /nix/store:/nix/store:ro"
    "-v /var/lib/local-llm/vllm-cache:/root/.cache"
    vllmImage
  ]
  ++ vllmArgs;

  start = pkgs.writeShellScript "vllm-start" ''
    exec ${podman} ${lib.concatStringsSep " \\\n  " podmanArgs}
  '';

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
  wantedBy = [ "container@local-llm.service" ];
  partOf = [ "container@local-llm.service" ];
  after = [
    "container@local-llm.service"
    "network-online.target"
    "vllm-image-pull.service"
  ];
  wants = [ "network-online.target" ];
  serviceConfig = {
    Type = "exec";
    ExecStart = start;
    ExecStartPost = waitHealthy;
    ExecStop = "${podman} stop -t 30 ${containerName}";
    TimeoutStartSec = 960;
    TimeoutStopSec = 60;
    Restart = "on-failure";
    RestartSec = 10;
  };
}
