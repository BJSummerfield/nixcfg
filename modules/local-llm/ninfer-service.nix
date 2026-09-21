{
  lib,
  pkgs,
  catalog,
  artifactOf,
  ninfer,
  port,
  requestLog,
}:
let
  name = catalog.default;
  m = catalog.models.${name};
  n = m.ninfer;

  num = builtins.toJSON;
  endpoint = "http://127.0.0.1:${toString port}";
  artifact = artifactOf name n.artifact;

  serveArgs = [
    artifact
    "--host 127.0.0.1"
    "--port ${toString port}"
    "--model-id ${name}"
    "--max-context ${num n.maxContext}"
    "--kv-capacity ${toString n.kvCapacity}"
    "--max-concurrency ${num n.maxConcurrency}"
    "--kv-dtype ${n.kvDtype}"
    "--prefill-chunk ${num n.prefillChunk}"
    "--device-state-slots ${num n.deviceStateSlots}"
    "--host-state-slots ${num n.hostStateSlots}"
    "--host-kv-mib ${num n.hostKvMib}"
    "--max-shared-prefixes ${num n.maxSharedPrefixes}"
    "--max-private-continuations ${num n.maxPrivateContinuations}"
    "--pending-timeout-ms ${num n.pendingTimeoutMs}"
    "--default-max-tokens ${num n.defaultMaxTokens}"
    "--request-log-jsonl ${requestLog}"
  ]
  ++ lib.optionals (n.spec != null) [
    "--spec ${n.spec}"
    "--draft-tokens ${num n.draftTokens}"
  ]
  ++ lib.optional (n.spec != null && n.lmHeadDraft) "--lm-head-draft"
  ++ lib.optional n.vision "--vision"
  ++ n.extraArgs;

  # NINFER_EXTRA_ARGS is appended last so its flags win; deliberately unquoted.
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
  description = "NInfer server (${name}) on ${endpoint}";
  after = [ "network-online.target" ];
  wants = [ "network-online.target" ];
  serviceConfig = {
    Type = "exec";
    EnvironmentFile = "-/var/lib/ninfer.env";
    ExecStart = start;
    ExecStartPost = waitHealthy;
    TimeoutStartSec = 960;
    TimeoutStopSec = 60;
    Restart = "on-failure";
    RestartSec = 10;
    # The host tier is pinned at startup; the default 8 MiB limit fails it.
    LimitMEMLOCK = "infinity";
  };
}
