{
  lib,
  pkgs,
  catalog,
  artifactOf,
  ninfer,
  hostAddress,
  port,
}:
let
  name = catalog.default;
  m = catalog.models.${name};
  n = m.ninfer;

  num = builtins.toJSON;
  endpoint = "http://${hostAddress}:${toString port}";
  artifact = artifactOf name n.artifact;

  serveArgs = [
    artifact
    "--host ${hostAddress}"
    "--port ${toString port}"
    "--model-id ${name}"
    "--max-context ${num n.maxContext}"
    "--kv-capacity ${toString n.kvCapacity}"
    "--max-concurrency ${num n.maxConcurrency}"
    "--kv-dtype ${n.kvDtype}"
    "--prefill-chunk ${num n.prefillChunk}"
    # Every one of these is a startup-fixed capacity; none of them auto-tunes.
    # Device state slots cost VRAM out of the same pool `--kv-capacity auto`
    # sizes (144 MiB per slot on this model); the host slots and host KV are
    # pinned RAM, which is why they are counted, not guessed.
    "--device-state-slots ${num n.deviceStateSlots}"
    "--host-state-slots ${num n.hostStateSlots}"
    "--host-kv-mib ${num n.hostKvMib}"
    # Upstream #270: the default shared-prefix catalog is smaller than one
    # request's own candidate ceiling, which silently kills reuse.
    "--max-shared-prefixes ${num n.maxSharedPrefixes}"
    "--max-private-continuations ${num n.maxPrivateContinuations}"
    # Default is 30s, which would 503 a queued agent turn behind a cold prefill.
    "--pending-timeout-ms ${num n.pendingTimeoutMs}"
    "--default-max-tokens ${num n.defaultMaxTokens}"
    "--request-log-jsonl /var/lib/local-llm/ninfer/requests.jsonl"
  ]
  ++ lib.optionals (n.spec != null) [
    "--spec ${n.spec}"
    "--draft-tokens ${num n.draftTokens}"
  ]
  ++ lib.optional (n.spec != null && n.lmHeadDraft) "--lm-head-draft"
  # Vision residency is independent of the speculative backend, and costs VRAM
  # that `--kv-capacity auto` would otherwise hand to the KV pool.
  ++ lib.optional n.vision "--vision"
  ++ n.extraArgs;

  # serve_options.cpp parses argv in order with no duplicate check, so anything
  # appended here wins over the flags above. That makes NINFER_EXTRA_ARGS a real
  # override and not just an extension: `--spec dflash2 --draft-tokens 7`
  # replaces the MTP selection without a rebuild. The exception is the boolean
  # flags (--lm-head-draft, --vision), which have no off-switch - turn those off
  # in models.nix. Deliberately unquoted: the file supplies several words.
  # shellcheck disable=SC2086
  start = pkgs.writeShellScript "ninfer-start" ''
    exec ${lib.getExe' ninfer "ninfer-serve"} ${lib.concatStringsSep " \\\n  " serveArgs} \
      ''${NINFER_EXTRA_ARGS-}
  '';

  waitHealthy = pkgs.writeShellScript "ninfer-wait-healthy" ''
    set -u
    for _ in $(${lib.getExe' pkgs.coreutils "seq"} 1 900); do
      ${lib.getExe' pkgs.coreutils "kill"} -0 "$MAINPID" 2>/dev/null || {
        echo "ninfer exited before becoming healthy" >&2
        exit 1
      }
      ${lib.getExe pkgs.curl} -sf --max-time 2 ${endpoint}/health >/dev/null && exit 0
      ${lib.getExe' pkgs.coreutils "sleep"} 1
    done
    echo "ninfer did not become healthy within 900s" >&2
    exit 1
  '';
in
{
  description = "NInfer server (${name}), the alternative engine on ${toString port}";
  # Deliberately not wantedBy anything: the engine you want at boot is chosen
  # by mine.system.local-llm.cuda.engine, which adds the wantedBy there.
  after = [
    "container@local-llm.service"
    "network-online.target"
  ];
  wants = [ "network-online.target" ];
  # One GPU, one resident model: starting either engine stops the other.
  conflicts = [ "vllm.service" ];
  serviceConfig = {
    Type = "exec";
    # Optional, hand-edited, survives a rebuild: one line of
    # NINFER_EXTRA_ARGS=... for A/B runs that should not cost a rebuild.
    EnvironmentFile = "-/var/lib/local-llm/ninfer.env";
    ExecStart = start;
    ExecStartPost = waitHealthy;
    TimeoutStartSec = 960;
    TimeoutStopSec = 60;
    Restart = "on-failure";
    RestartSec = 10;
    StateDirectory = "local-llm/ninfer";
    # Host State and Host KV are pinned at startup (~9 GiB at the current
    # sizing), and pinning fails outright against the default 8 MiB limit.
    LimitMEMLOCK = "infinity";
  };
}
