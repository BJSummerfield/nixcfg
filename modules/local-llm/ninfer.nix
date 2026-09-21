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
in
{
  systemd.tmpfiles.rules = [ "d ${stateDir} 0755 root root -" ];

  systemd.services.ninfer = ninferService // wanted;

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
