{
  lib,
  pkgs,
  catalog,
  artifactOf,
  ninfer,
  enginePort,
  metricsPort,
  autoStart,
  ...
}:
let
  stateDir = "/var/lib/ninfer";
  requestLog = "${stateDir}/requests.jsonl";

  ninferService = import ./ninfer-service.nix {
    inherit
      lib
      pkgs
      catalog
      artifactOf
      ninfer
      requestLog
      ;
    port = enginePort;
  };

  ninfer-metrics = pkgs.writers.writePython3Bin "ninfer-metrics" {
    flakeIgnore = [ "E501" ];
  } (builtins.readFile ./ninfer-metrics.py);

  wanted = lib.optionalAttrs autoStart { wantedBy = [ "multi-user.target" ]; };

  systemctl = lib.getExe' pkgs.systemd "systemctl";

  watchdog = pkgs.writeShellScript "ninfer-watchdog" ''
    set -u
    ${systemctl} is-active --quiet ninfer.service || exit 0
    for attempt in 1 2 3; do
      [ "$attempt" = 1 ] || ${lib.getExe' pkgs.coreutils "sleep"} 20
      code=$(${lib.getExe pkgs.curl} -s -o /dev/null -w '%{http_code}' --max-time 5 \
        http://127.0.0.1:${toString enginePort}/health)
      [ "$code" = 503 ] || exit 0
    done
    echo "ninfer /health answered 503 three times over 40s; restarting ninfer" >&2
    ${systemctl} restart ninfer.service
  '';
in
{
  systemd.tmpfiles.rules = [ "d ${stateDir} 0755 root root -" ];

  systemd.services.ninfer = ninferService // wanted;

  systemd.services.ninfer-watchdog = {
    description = "Restart NInfer when its /health stays at 503";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = watchdog;
    };
  };

  systemd.timers.ninfer-watchdog = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5min";
      OnUnitActiveSec = "1min";
    };
  };

  systemd.services.ninfer-metrics = {
    description = "NInfer health and performance metrics from ${requestLog}";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      Type = "exec";
      ExecStart = lib.concatStringsSep " " [
        (lib.getExe ninfer-metrics)
        "--log ${requestLog}"
        "--engine http://127.0.0.1:${toString enginePort}"
        "--host 127.0.0.1"
        "--port ${toString metricsPort}"
      ];
      Restart = "on-failure";
      RestartSec = 5;
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
    };
  };
}
