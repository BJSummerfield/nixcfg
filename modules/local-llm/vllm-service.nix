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

  # One flag per line, in vLLM's documented order.
  vllmArgs = [
    "--model /model"
    "--served-model-name ${servedNames}"
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

  podmanArgs = [
    "run --rm --replace --pull=never"
    "--name ${containerName}"
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
      ${lib.getExe pkgs.curl} -sf --max-time 2 ${endpoint}/health >/dev/null && exit 0
      ${lib.getExe' pkgs.coreutils "sleep"} 1
    done
    echo "vllm did not become healthy within 900s" >&2
    exit 1
  '';
in
{
  description = "vLLM OpenAI server (${name})";
  wantedBy = [ "multi-user.target" ];
  after = [
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
