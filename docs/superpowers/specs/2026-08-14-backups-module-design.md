# Backups: generalize the Stalwart restic pattern to the other stateful services

## Problem

Stalwart is the only service with a backup. `services.restic.backups.stalwart`
in `modules/stalwart-server/nixos.nix` ships `/var/lib/stalwart-data` to B2
twice daily, stopping the container around the run. Everything else with
irreplaceable state has nothing:

- **Immich Postgres** (paynefield): albums, favorites, faces, sharing. The
  photo blobs live on the NAS (which has its own backup), but the metadata
  DB lives in the container and its dumps are only as safe as the NAS.
- **Vikunja** (paynefield): a nightly `pg_dump` timer already writes
  `/var/lib/postgresql/dumps/vikunja.dump` *inside* the container, and the
  module comment promises "Restic on the host backs up the container's whole
  state dir" — that restic job was never written. The dump never leaves the
  box.
- **Jellyfin** (paynefield): the sqlite library (users, watch state) sits in
  the container rootfs at
  `/var/lib/nixos-containers/jellyfin/var/lib/private/jellyfin`. No host
  bind, no backup.
- **TeamSpeak** (vps): `ts3server.sqlitedb` holds the server identity —
  losing it forces every client to re-trust a new server. Container rootfs,
  no backup.
- **AdGuard** (paynefield): `/var/lib/adguardhome-data/AdGuardHome.yaml` is
  hand-edited runtime state (admin hash, custom rules, client names).

No host uses btrfs/zfs, so there are no filesystem snapshots to lean on;
consistency must come from stopping the service or from app-level dumps.

## Goal

Every small, irreplaceable piece of state on paynefield and vps lands in an
encrypted off-site restic repository nightly, using the pattern Stalwart
already proved, without duplicating its boilerplate per service.

## Decisions

- **One restic job per host, not per service.** restic locks its repository;
  a single nightly run avoids lock contention, needs one B2 credential per
  host, and the data is small enough (DB dumps, config files) that one
  window covers it. Per-service prune/schedule control is not needed.
- **One B2 bucket per host** (`spacefunk-<host>-backups`), mirroring the
  mail bucket's naming. Buckets and application keys are created manually,
  as Stalwart's were.
- **Stalwart stays as-is.** Its job, bucket and twice-daily schedule are
  untouched. Migrating it onto the module is a possible later cleanup, not
  part of this work.
- **Two consistency strategies, chosen per service:**
  - *dump*: Postgres data is backed up as `pg_dump -Fc` output on a
    host-visible path. Dumps restore across Postgres versions; raw datadir
    copies do not.
  - *stop*: sqlite-in-rootfs services (Jellyfin, TeamSpeak) are backed up
    raw, with the container stopped for the minutes the run takes at 04:00.
- **AdGuard is copied live.** Stopping the dns container kills LAN DNS; a
  mid-write race on a rarely-rewritten yaml is an acceptable risk.
- **Services self-register; backups always run host-side.** Each service
  module appends its paths and stop-list when both it and `mine.backups`
  are enabled — the same enable-gated pattern every `mine.*` module already
  uses. The backups module itself knows nothing about individual services.
  The restic job runs on the host, never inside a container, for Stalwart's
  stated reason: containers never see the B2 credentials, so a compromised
  service cannot touch its own backups.
- **Host age keys are not backed up.** If a host disk is lost, recovery is
  re-keying: add the rebuilt host's key to `.sops.yaml` and re-encrypt.
- **Repo passwords also live in 1Password.** The sops copy dies with the
  host disk; without an out-of-band copy the B2 backups would be
  unreadable exactly when they are needed.
- **04:00 run.** The whole host job runs at 04:00 — the hour Jellyfin and
  TeamSpeak may be stopped. Dump-strategy services only need restic to pick
  up files their own timers wrote earlier, so one shared hour costs
  nothing.

## Scope

**In:**

- `modules/backups/nixos.nix` — new module, imported from
  `modules/nixos.nix`
- `modules/immich-server/nixos.nix`, `modules/vikunja-server/nixos.nix`,
  `modules/jellyfin-server/nixos.nix`, `modules/teamspeak-server/nixos.nix`,
  `modules/dns-server/nixos.nix` — self-registration blocks
- `hosts/paynefield/default.nix`, `hosts/vps/default.nix` — enable, sops
  secret wiring
- `secrets/hosts/paynefield.yaml`, `secrets/hosts/vps.yaml` — two new
  secrets each
- Manual: two B2 buckets + app keys, passwords into 1Password

**Out:** redtruck/t495/elitebook (devbox worktrees are GitHub-backed; adding
a host later is an enable plus two secrets), Immich media (NAS-backed),
host age keys (recovery is re-keying `.sops.yaml`), migrating Stalwart,
restore automation, backup alerting, local-llm open-webui DB.

## Approach

### The module

`mine.backups` collects contributions and emits one restic job:

```nix
mine.backups = {
  enable = lib.mkEnableOption "nightly restic backups to B2";
  repository = ...;       # "b2:spacefunk-<host>-backups:<host>"
  repoPasswordFile = ...; # sops path
  b2EnvFile = ...;        # sops path, B2_ACCOUNT_ID/B2_ACCOUNT_KEY
  schedule = ...;         # default [ "04:00" ]
  paths = ...;            # listOf path, appended to by service modules
  stopContainers = ...;   # listOf str, appended to by service modules
};
```

The emitted `services.restic.backups.host` mirrors Stalwart's:
`initialize = true`, `Persistent = true`, prune 30d/12w/12m,
`backupPrepareCommand` stops each listed container (`|| true`),
`backupCleanupCommand` restarts them.

Assertions: when enabled, `repository`, `repoPasswordFile` and `b2EnvFile`
must be set and `paths` must be non-empty — enabling backups on a host
where no service registered anything is a misconfiguration, not a no-op.

### Per-service registration

Each block is `lib.mkIf (cfg.enable && config.mine.backups.enable)` inside
the service module's existing `config`:

- **Immich** — Immich's built-in nightly database dump writes to
  `/var/lib/immich/backups`, which is already bind-mounted from
  `${immichMountPoint}/backups` (the NAS). Register that *host* path. This
  double-covers the dumps (NAS backup + B2) deliberately: the NAS backup is
  unmanaged by this repo and unverifiable from here. Implementation must
  verify dumps actually appear there (the built-in backup is on by default
  but could be disabled in instance settings); if absent, fall back to a
  Vikunja-style `pg_dump` timer in the container writing under the
  `/var/lib/immich-data` bind.
- **Vikunja** — add a container bind mount: host `/var/lib/vikunja-dumps` →
  container `/var/lib/postgresql/dumps` (where the existing timer already
  writes). Register the host path. Ownership inside the container is
  already handled by its tmpfiles rule.
- **Jellyfin** — register
  `/var/lib/nixos-containers/jellyfin/var/lib/private/jellyfin` and add
  `jellyfin` to `stopContainers`.
- **TeamSpeak** — register
  `/var/lib/nixos-containers/teamspeak/var/lib/private/teamspeak3-server`
  and add `teamspeak` to `stopContainers`.
- **AdGuard** — register `/var/lib/adguardhome-data`. No stop.

### Host wiring

Per host, two sops secrets following the Stalwart wiring in
`hosts/vps/default.nix`:

```nix
sops.secrets = {
  restic-b2-env.sopsFile = ../../secrets/hosts/<host>.yaml;
  restic-repo-password.sopsFile = ../../secrets/hosts/<host>.yaml;
};

mine.backups = {
  enable = true;
  repository = "b2:spacefunk-<host>-backups:<host>";
  b2EnvFile = config.sops.secrets.restic-b2-env.path;
  repoPasswordFile = config.sops.secrets.restic-repo-password.path;
};
```

### Restore

Documented in the module header comment, Stalwart-style:

- Files (sqlite dirs, yaml): `restic restore latest --target /` scoped
  with `--include`, container stopped.
- Postgres: `pg_restore -Fc` into a freshly created database inside the
  container, service stopped.
- Host loss: rebuild via disko, add the new host key to `.sops.yaml` and
  re-encrypt secrets, retrieve the repo password from 1Password, restore
  state.

## Failure modes

| Situation | Result |
|---|---|
| Backup run fails | Failed systemd unit, visible in `systemctl --failed`. No alerting in v1. |
| Container fails to restart after backup | `\|\| true` on cleanup means the run still succeeds; the failed container unit is the signal. Same residual risk Stalwart carries today. |
| B2 credentials revoked/expired | Run fails, previous snapshots intact. |
| NAS unmounted during run (Immich path) | Path missing; restic errors on the missing path and the run fails loudly rather than silently backing up nothing. |
| AdGuard yaml rewritten mid-copy | Torn copy possible in one snapshot; previous and next snapshots are clean. Accepted. |
| Host disk lost | Re-provision via disko, re-key `.sops.yaml` for the new host key, repo password from 1Password, restore state. |

## Verification

- `nix flake check` passes; paynefield and vps evaluate with the module
  enabled (CI covers this automatically).
- With a service enabled but `mine.backups` disabled, evaluation still
  passes and no restic job exists.
- On paynefield after deploy: `systemctl list-timers` shows the restic
  timer; a manual `systemctl start restic-backups-host` produces a snapshot
  containing the Immich dumps, Vikunja dump, Jellyfin dir and AdGuard yaml;
  `restic snapshots` lists it.
- Jellyfin container stops during the run and is running again after.
- Restore drill (manual, once): restore the Vikunja dump to a scratch
  database and confirm `pg_restore` succeeds.

## Success Criteria

- Nightly snapshots for paynefield and vps exist in their B2 buckets.
- Every gap in the Problem section except the out-of-scope hosts is covered.
- Enabling backups on a new host requires only the host-wiring block and
  two secrets.
- Stalwart's existing backup is unchanged.
