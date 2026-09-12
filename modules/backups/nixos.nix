# Restore:
#   Files (sqlite dirs, yaml) — stop the owning container, then:
#     restic -r <repository> restore latest --target / --include <path>
#   Postgres — restore the -Fc dump inside the container as postgres:
#     pg_restore --clean --if-exists -d <db> <dump>
#   Host loss — rebuild via disko, add the new host key to .sops.yaml and
#   re-encrypt, fetch the repo password from 1Password, restore as above.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.backups;

  timeout = lib.getExe' pkgs.coreutils "timeout";
  date = lib.getExe' pkgs.coreutils "date";
  cat = lib.getExe' pkgs.coreutils "cat";
  rm = lib.getExe' pkgs.coreutils "rm";

  startedStateFile = "/run/mine-backups-started";

  sender = pkgs.callPackage ../keybase-notify/package.nix { urlFile = cfg.notifyUrlFile; };

  # message may itself contain shell variable references (e.g. "$took"),
  # so it is embedded in double quotes rather than shell-escaped.
  notify = message: ''${timeout} 25 ${lib.getExe sender} "${message}" || true'';

  startedMessage =
    if cfg.stopContainers == [ ] then
      "💾 Backup started"
    else
      "💾 Backup started; ${lib.concatStringsSep ", " cfg.stopContainers} "
      + (if builtins.length cfg.stopContainers == 1 then "is" else "are")
      + " down until it finishes";
in
{
  options.mine.backups = {
    enable = lib.mkEnableOption "nightly restic backups to B2";

    repository = lib.mkOption {
      type = lib.types.str;
      example = "s3:s3.us-east-005.backblazeb2.com/spacefunk-nix-backups/paynefield";
      description = "restic repository URL (S3-compatible endpoint + bucket + path).";
    };

    repoPasswordFile = lib.mkOption {
      type = lib.types.path;
      description = "Host path to the restic repository password.";
    };

    b2EnvFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to a restic S3 credentials env file containing:
          AWS_ACCESS_KEY_ID=<keyID>
          AWS_SECRET_ACCESS_KEY=<applicationKey>
      '';
    };

    schedule = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "05:15" ];
      description = ''
        systemd OnCalendar times. 05:15 sits after the auto-upgrade reboot
        window (03:00-05:00) closes, so an upgrade reboot cannot cut a run
        short, and is the hour stop-strategy containers (jellyfin, teamspeak,
        stalwart) may be down; dump-strategy services only need their own
        timers to have fired earlier (vikunja 00:00, immich 02:00).
      '';
    };

    paths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Paths to back up. Service modules append to this.";
    };

    stopContainers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Containers stopped for the duration of the run, for a consistent
        copy of sqlite state living in the container rootfs.
      '';
    };

    notifyUrlFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Host path to a file holding a Keybase webhookbot URL (e.g.
        config.sops.secrets.keybase-webhook-url.path). When set, backup
        start, success and failure are posted there; posts that fail or
        hang are ignored. A string rather than a path, so a Nix path
        literal can't copy the secret into the store. Null posts nothing
        and leaves the prepare/cleanup scripts unchanged.
      '';
      example = "/run/secrets/keybase-webhook-url";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.paths != [ ];
        message = "mine.backups is enabled but no service registered any paths";
      }
    ];

    services.restic.backups.host = {
      initialize = true;
      inherit (cfg) repository;
      passwordFile = cfg.repoPasswordFile;
      environmentFile = cfg.b2EnvFile;
      inherit (cfg) paths;
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
      };
      backupPrepareCommand =
        lib.optionalString (cfg.notifyUrlFile != null) ''
          ${date} +%s > ${startedStateFile}
          ${notify startedMessage}
        ''
        + lib.concatMapStringsSep "\n" (
          c: "${pkgs.nixos-container}/bin/nixos-container stop ${c} || true"
        ) cfg.stopContainers;
      backupCleanupCommand =
        lib.concatMapStringsSep "\n" (
          c: "${pkgs.nixos-container}/bin/nixos-container start ${c} || true"
        ) cfg.stopContainers
        + lib.optionalString (cfg.notifyUrlFile != null) ''

          if [ "$SERVICE_RESULT" = success ]; then
            started=$(${cat} ${startedStateFile} 2>/dev/null || echo "$(${date} +%s)")
            took=$(( ($(${date} +%s) - started) / 60 ))
            ${notify "✅ Backup finished (took $took min)"}
          else
            ${notify "🚨 *Backup FAILED*"}
          fi
          ${rm} -f ${startedStateFile}
        '';
      pruneOpts = [
        "--keep-daily 30"
        "--keep-weekly 12"
        "--keep-monthly 12"
      ];
    };
  };
}
