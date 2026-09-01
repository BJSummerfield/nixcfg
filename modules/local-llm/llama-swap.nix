# Catalog → llama-swap YAML config.
# Per-model args so multiple backends can coexist.
{
  lib,
  pkgs,
  catalog,
  weightsOf,
  vllmImage,
  podmanCli,
  hostAddress,
}:
let
  inherit (catalog) models enabled;

  num = builtins.toJSON;

  # container name is cosmetic (--rm --replace)
  containerName = name: "vllm-${lib.toLower name}";

  # one flag per line, in vLLM's documented order; these become the body of
  # the `cmd: |` block scalar
  vllmArgs =
    name: m:
    [
      "${podmanCli} run --rm --replace --pull=never"
      "--name ${containerName name}"
      # --rm means the container's own log store dies with it, and vLLM's
      # startup lines are the ones every tuning comment in models.nix tells you
      # to go read: "GPU KV cache size", "Setting attention block size to N
      # tokens", the max_num_scheduled_tokens advisory. journald keeps them past
      # the container, so `journalctl CONTAINER_NAME=vllm-<lowercased model>`
      # still answers "what did it decide on the last start" after a replace.
      #
      # Pinned rather than changed: podman on a systemd host generally defaults
      # here already via containers.conf. Same reasoning as --mamba-cache-mode
      # align below — state the behaviour we depend on instead of inheriting it.
      # This is a server-side storage option and does not touch the attach
      # stream, so llama-swap's own /logs view is unaffected.
      "--log-driver=journald"
      "--device nvidia.com/gpu=all"
      "--ipc=host"
      "-e HF_HUB_OFFLINE=1"
      "-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
      "-p ${hostAddress}:\${PORT}:8000"
      "-v ${weightsOf name m}:/model:ro"
      # the model dir is a store symlink farm, so the targets must be reachable
      "-v /nix/store:/nix/store:ro"
      "-v /var/lib/local-llm/vllm-cache:/root/.cache"
      vllmImage
      "--model /model"
      "--served-model-name ${name}"
      "--kv-cache-dtype ${m.vllm.kvCacheDtype}"
      "--max-model-len ${num m.maxModelLen}"
      "--gpu-memory-utilization ${num m.vllm.gpuMemoryUtilization}"
      # served text-only: weights alone are ~22GiB of a 31GiB card, and the
      # vision-encoder profiling buffers OOMed startup
      "--limit-mm-per-prompt '{\"image\":0,\"video\":0}'"
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

  modelLines =
    name:
    let
      m = models.${name};
      aliasNames = builtins.attrNames (m.aliases or { });
    in
    [ "  \"${name}\":" ]
    ++ lib.optionals (aliasNames != [ ]) (
      [ "    aliases:" ]
      ++ map (a: "      - \"${a}\"") aliasNames
      # rewrites the model field back to the name vLLM was started with
      ++ [ "    useModelName: \"${name}\"" ]
    )
    ++ lib.optional (m.ttl != null) "    ttl: ${num m.ttl}"
    ++ [
      "    proxy: http://${hostAddress}:\${PORT}"
      "    cmd: |"
    ]
    ++ map (arg: "      ${arg}") (vllmArgs name m)
    ++ [ "    cmdStop: ${podmanCli} stop -t 30 ${containerName name}" ];
in
pkgs.writeText "llama-swap.yaml" (
  lib.concatStringsSep "\n" (
    [
      # a vLLM cold start is minutes, not the ~15s a GGUF mmap was
      "healthCheckTimeout: 900"
      "logLevel: info"
      "models:"
    ]
    ++ lib.concatMap (name: modelLines name ++ [ "" ]) enabled
  )
)
