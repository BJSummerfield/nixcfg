# Nightly restic backups to B2, generalizing the pattern proven by
# modules/stalwart-server/nixos.nix: ONE job per host, running HOST-side so
# no container ever sees the B2 credentials — a compromised service cannot
# read, delete or poison its own backups.
#
# This module knows nothing about individual services. Each service module
# appends its own state paths to mine.backups.paths (and, for services whose
# sqlite lives in the container rootfs, its container name to
# stopContainers) guarded on mine.backups.enable — so registrations are
# inert until a host opts in.
#
# The repo password's sops copy is decrypted by this host's SSH key and dies
# with the disk: keep a copy in 1Password or the backups are unreadable
# exactly when they are needed.
#
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
      default = [ "04:00" ];
      description = ''
        systemd OnCalendar times. 04:00 is the hour stop-strategy containers
        (jellyfin, teamspeak) may be down; dump-strategy services only need
        their own timers to have fired earlier (vikunja 00:00, immich 02:00).
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
      repository = cfg.repository;
      passwordFile = cfg.repoPasswordFile;
      environmentFile = cfg.b2EnvFile;
      paths = cfg.paths;
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
      };
      # `|| true` on stop: a container already down must not abort the run.
      # `|| true` on start: a restart failure surfaces as the container's own
      # failed unit, not as a failed backup that actually uploaded fine.
      backupPrepareCommand = lib.concatMapStringsSep "\n" (
        c: "${pkgs.nixos-container}/bin/nixos-container stop ${c} || true"
      ) cfg.stopContainers;
      backupCleanupCommand = lib.concatMapStringsSep "\n" (
        c: "${pkgs.nixos-container}/bin/nixos-container start ${c} || true"
      ) cfg.stopContainers;
      pruneOpts = [
        "--keep-daily 30"
        "--keep-weekly 12"
        "--keep-monthly 12"
      ];
    };
  };
}
