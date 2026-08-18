# mine.backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One host-side restic job per host ships every small, irreplaceable piece of service state to B2 nightly, with services self-registering their paths.

**Architecture:** A new `mine.backups` module collects `paths` and `stopContainers` contributions and emits a single `services.restic.backups.host` job (04:00, prune 30d/12w/12m). Service modules contribute their state paths guarded on `config.mine.backups.enable`, so everything is inert until a host enables backups. Stalwart's existing job is untouched.

**Tech Stack:** NixOS module system, `services.restic.backups`, sops-nix, nixos-container, B2.

**Spec:** `docs/superpowers/specs/2026-08-14-backups-module-design.md`

## Global Constraints

- Formatter: run `nix fmt` before every commit; CI rejects unformatted files.
- Comments explain *why*, never narrate the change or the next line (repo comment-style spec).
- Verification command for every task: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath` (and `...vps...` where noted); full `nix flake check` before the final commit of the branch.
- Tasks 1–5 must leave every host evaluating green with backups still disabled everywhere — they are safe to merge without any B2 setup.
- Task 6 is HUMAN-ONLY (B2 buckets, 1Password, sops edits). Task 7 depends on it.
- All work on a feature branch; repo commit style is `feat(scope): ...` / `fix(scope): ...`.

---

### Task 1: Core module `modules/backups/nixos.nix`

**Files:**
- Create: `modules/backups/nixos.nix`
- Modify: `modules/nixos.nix` (import list, alphabetical position after `./avahi/nixos.nix`)
- Test: evaluation via `nix eval` (this repo's test harness is eval; there is no unit-test framework)

**Interfaces:**
- Produces (consumed by Tasks 2–5, 7):
  - `mine.backups.enable` : bool
  - `mine.backups.repository` : str (no default; only read when enabled)
  - `mine.backups.repoPasswordFile`, `mine.backups.b2EnvFile` : path
  - `mine.backups.schedule` : listOf str, default `[ "04:00" ]`
  - `mine.backups.paths` : listOf str, default `[ ]` — service modules append
  - `mine.backups.stopContainers` : listOf str, default `[ ]` — service modules append
- Emits `services.restic.backups.host` → systemd units `restic-backups-host.{service,timer}`

- [ ] **Step 1: Write the failing eval test — reference the option before it exists**

Temporarily add to `hosts/paynefield/default.nix`, inside the top-level attrset (next to `environment.pathsToLink`):

```nix
  # TEMP eval probe for mine.backups — removed before commit
  mine.backups = {
    enable = true;
    repository = "b2:probe:probe";
    repoPasswordFile = "/dev/null";
    b2EnvFile = "/dev/null";
  };
```

- [ ] **Step 2: Run eval to verify it fails**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: FAIL with `The option 'mine.backups' does not exist`

- [ ] **Step 3: Write the module**

Create `modules/backups/nixos.nix`:

```nix
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
      example = "b2:spacefunk-paynefield-backups:paynefield";
      description = "restic repository URL (B2 bucket + path).";
    };

    repoPasswordFile = lib.mkOption {
      type = lib.types.path;
      description = "Host path to the restic repository password.";
    };

    b2EnvFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to a restic B2 credentials env file containing:
          B2_ACCOUNT_ID=<keyID>
          B2_ACCOUNT_KEY=<applicationKey>
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
```

In `modules/nixos.nix`, add the import after `./avahi/nixos.nix`:

```nix
    ./backups/nixos.nix
```

- [ ] **Step 4: Run eval to verify the assertion now fires**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: FAIL with `mine.backups is enabled but no service registered any paths` — the module exists and its guard works.

- [ ] **Step 5: Remove the probe and verify green**

Delete the TEMP block from `hosts/paynefield/default.nix`.
Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: PASS (prints a `/nix/store/...drv` path). The module is inert when disabled.

- [ ] **Step 6: Format and commit**

```bash
nix fmt
git add modules/backups/nixos.nix modules/nixos.nix
git commit -m "feat(backups): mine.backups module, one host-side restic job to B2"
```

---

### Task 2: Vikunja — surface the dump on the host and register it

**Files:**
- Modify: `modules/vikunja-server/nixos.nix` (activation script ~line 43, `bindMounts` ~line 62, registration in the host-side `config` block, stale comments at ~lines 39–42 and ~120–122)
- Test: evaluation via `nix eval`

**Interfaces:**
- Consumes: `mine.backups.enable`, `mine.backups.paths` (Task 1)
- Produces: host path `/var/lib/vikunja-dumps` containing `vikunja.dump` (pg_dump -Fc, written nightly at 00:00 by the existing in-container timer)

- [ ] **Step 1: Add the host dir and bind mount**

In the activation script, extend `system.activationScripts.vikunja-dirs`:

```nix
    system.activationScripts.vikunja-dirs = ''
      mkdir -p /var/lib/tailscale-vikunja
      chmod 700 /var/lib/tailscale-vikunja
      mkdir -p /var/lib/vikunja-dumps
      chmod 700 /var/lib/vikunja-dumps
    '';
```

In `containers.vikunja.bindMounts`, add:

```nix
        # Surfaces the nightly pg_dump on the host so the host-side restic
        # job (modules/backups/nixos.nix) can ship it. The container's
        # tmpfiles rule re-owns the mount to its postgres user on start.
        "/var/lib/postgresql/dumps" = {
          hostPath = "/var/lib/vikunja-dumps";
          isReadOnly = false;
        };
```

- [ ] **Step 2: Register with mine.backups**

Inside the same `config = lib.mkIf cfg.enable { ... }` block (next to `networking.nat`):

```nix
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/vikunja-dumps" ];
    };
```

- [ ] **Step 3: Fix the two stale comments**

Replace the comment above `system.activationScripts.vikunja-dirs` (the "Back that path up with restic for disaster recovery." paragraph) with exactly:

```nix
    # Tailscale state and the DB dump are the only things persisted on the
    # host directly. Vikunja files + Postgres data live inside the
    # container's own filesystem at /var/lib/nixos-containers/vikunja/,
    # which survives restarts and rebuilds; the nightly dump surfaced at
    # /var/lib/vikunja-dumps is what mine.backups ships off-site.
```

And update the comment above `systemd.services.vikunja-db-dump` (inside the container config) to:

```nix
          # Nightly DB dump, written where the bind mount surfaces it on the
          # host as /var/lib/vikunja-dumps for the host-side restic job.
          # Written as postgres via -Fc so restores work across Postgres
          # versions; the tmp-then-mv keeps restic from shipping a torn dump.
```

- [ ] **Step 4: Run eval to verify green**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
nix fmt
git add modules/vikunja-server/nixos.nix
git commit -m "feat(vikunja): surface the nightly dump on the host, register with mine.backups"
```

---

### Task 3: Immich — register the NAS-mounted dump dir

**Files:**
- Modify: `modules/immich-server/nixos.nix` (registration in the host-side `config` block)
- Test: evaluation via `nix eval`

**Interfaces:**
- Consumes: `mine.backups.enable`, `mine.backups.paths` (Task 1); `immichMountPoint` (already in the module's `let`, = `config.mine.system.nas.shares.immich.mountPoint`)

- [ ] **Step 1: Register with mine.backups**

Inside `config = lib.mkIf cfg.enable { ... }` (next to `networking.nat`):

```nix
    # Immich's built-in nightly DB backup (02:00) writes pg_dump output to
    # /var/lib/immich/backups, bind-mounted from the NAS. Registering the
    # host-side mount ships those dumps to B2 as well — the NAS's own backup
    # is unmanaged by this repo and unverifiable from here. Photo blobs stay
    # NAS-only by design; only the DB metadata is irreplaceable here.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "${immichMountPoint}/backups" ];
    };
```

- [ ] **Step 2: Run eval to verify green**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: PASS.

- [ ] **Step 3: Format and commit**

```bash
nix fmt
git add modules/immich-server/nixos.nix
git commit -m "feat(immich): register the NAS dump dir with mine.backups"
```

Note for Task 7's deploy verification: the spec requires confirming dumps actually exist in that dir (`ls /mnt/secure/nas/immich/backups` on paynefield). If Immich's built-in backup was disabled in instance settings, the fallback is a Vikunja-style pg_dump timer in the container writing under the `/var/lib/immich-data` bind — that fallback is out of scope unless the check fails.

---

### Task 4: Jellyfin and TeamSpeak — stop-strategy registrations

**Files:**
- Modify: `modules/jellyfin-server/nixos.nix` (registration in the host-side `config` block)
- Modify: `modules/teamspeak-server/nixos.nix` (registration in the host-side `config` block)
- Test: evaluation via `nix eval` (paynefield for jellyfin, vps for teamspeak)

**Interfaces:**
- Consumes: `mine.backups.enable`, `mine.backups.paths`, `mine.backups.stopContainers` (Task 1)

- [ ] **Step 1: Register jellyfin**

In `modules/jellyfin-server/nixos.nix`, inside `config = lib.mkIf cfg.enable { ... }` (next to `networking.nat`):

```nix
    # Jellyfin runs DynamicUser with StateDirectory=jellyfin, so its sqlite
    # library (users, watch state) lives in the container rootfs with no
    # host bind. Backed up raw with the container stopped — sqlite copied
    # live can be torn, and minutes of downtime at 04:00 are free.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/nixos-containers/jellyfin/var/lib/private/jellyfin" ];
      stopContainers = [ "jellyfin" ];
    };
```

- [ ] **Step 2: Register teamspeak**

In `modules/teamspeak-server/nixos.nix`, inside `config = lib.mkIf cfg.enable { ... }` (next to `networking.nat`):

```nix
    # ts3server.sqlitedb holds the server identity — losing it forces every
    # client to re-trust a new server. Rootfs path (DynamicUser +
    # StateDirectory), so: stop, copy raw, restart.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/nixos-containers/teamspeak/var/lib/private/teamspeak3-server" ];
      stopContainers = [ "teamspeak" ];
    };
```

- [ ] **Step 3: Run eval on both hosts to verify green**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Run: `nix eval --raw .#nixosConfigurations.vps.config.system.build.toplevel.drvPath`
Expected: both PASS.

- [ ] **Step 4: Format and commit**

```bash
nix fmt
git add modules/jellyfin-server/nixos.nix modules/teamspeak-server/nixos.nix
git commit -m "feat(backups): register jellyfin and teamspeak sqlite state, stopped during the run"
```

---

### Task 5: AdGuard — live-copy registration

**Files:**
- Modify: `modules/dns-server/nixos.nix` (registration in the host-side `config` block)
- Test: evaluation via `nix eval`

**Interfaces:**
- Consumes: `mine.backups.enable`, `mine.backups.paths` (Task 1)

- [ ] **Step 1: Register the AdGuard state dir**

Inside the module's `config = lib.mkIf cfg.enable { ... }` block (next to the other host-side settings, e.g. near `system.activationScripts`):

```nix
    # mutableSettings=true makes AdGuardHome.yaml hand-edited runtime state
    # (admin hash, custom rules, client names). Copied live, container
    # running: stopping the dns container kills LAN DNS, and a torn copy of
    # a rarely-rewritten yaml self-heals in the next snapshot.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/adguardhome-data" ];
    };
```

- [ ] **Step 2: Run eval to verify green**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: PASS.

- [ ] **Step 3: Format, commit, and run the full check**

```bash
nix fmt
git add modules/dns-server/nixos.nix
git commit -m "feat(dns): register adguard state with mine.backups"
nix flake check --print-build-logs
```

Expected: `nix flake check` PASS — everything so far is inert (no host enables backups), so this is the natural merge point for the module + registrations.

---

### Task 6: HUMAN — B2 buckets, passwords, sops secrets

No code. The executor STOPS here and hands this checklist to the human; Task 7 cannot evaluate until it is done (sops-nix asserts at eval time that referenced keys exist in the yaml).

- [ ] Create B2 bucket `spacefunk-paynefield-backups` (private) and an application key scoped to only that bucket.
- [ ] Create B2 bucket `spacefunk-vps-backups` (private) and an application key scoped to only that bucket.
- [ ] Generate two restic repo passwords (e.g. `openssl rand -base64 32`), one per host. **Store both in 1Password** — the sops copies die with the host disks.
- [ ] `sops secrets/hosts/paynefield.yaml` — add:
  - `restic-b2-env`: multiline value `B2_ACCOUNT_ID=<keyID>` newline `B2_ACCOUNT_KEY=<applicationKey>`
  - `restic-repo-password`: the paynefield password
- [ ] `sops secrets/hosts/vps.yaml` — add the same two keys with the vps credentials.
- [ ] Commit the re-encrypted yaml files:

```bash
git add secrets/hosts/paynefield.yaml secrets/hosts/vps.yaml
git commit -m "chore(secrets): restic B2 credentials for paynefield and vps"
```

---

### Task 7: Host wiring and verification

**Files:**
- Modify: `hosts/paynefield/default.nix` (sops secrets next to `vikunja-jwt-secret` ~line 16; `backups` block inside the existing `mine = { ... }` attrset)
- Modify: `hosts/vps/default.nix` (sops secrets next to the stalwart ones ~line 43; `backups` block inside `mine = { ... }`)
- Test: evaluation + post-deploy checks

**Interfaces:**
- Consumes: everything from Tasks 1–6. Secret names must match Task 6 exactly: `restic-b2-env`, `restic-repo-password`.

- [ ] **Step 1: Write the failing eval test — enable before declaring secrets**

In `hosts/paynefield/default.nix`, inside the `mine = { ... }` attrset (sibling of `system`), add only:

```nix
    backups = {
      enable = true;
      repository = "b2:spacefunk-paynefield-backups:paynefield";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
    };
```

- [ ] **Step 2: Run eval to verify it fails**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: FAIL — `restic-b2-env` is not declared in `sops.secrets`.

- [ ] **Step 3: Declare the secrets**

In `hosts/paynefield/default.nix`, next to `sops.secrets.vikunja-jwt-secret`:

```nix
  sops.secrets.restic-b2-env = {
    sopsFile = ../../secrets/hosts/paynefield.yaml;
    mode = "0400";
  };
  sops.secrets.restic-repo-password = {
    sopsFile = ../../secrets/hosts/paynefield.yaml;
    mode = "0400";
  };
```

- [ ] **Step 4: Run eval to verify paynefield is green**

Run: `nix eval --raw .#nixosConfigurations.paynefield.config.system.build.toplevel.drvPath`
Expected: PASS.

- [ ] **Step 5: Wire vps the same way**

In `hosts/vps/default.nix`, next to the stalwart sops secrets:

```nix
  sops.secrets.restic-b2-env = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
  sops.secrets.restic-repo-password = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
```

Inside `mine = { ... }`:

```nix
    backups = {
      enable = true;
      repository = "b2:spacefunk-vps-backups:vps";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
    };
```

- [ ] **Step 6: Run the full check**

Run: `nix eval --raw .#nixosConfigurations.vps.config.system.build.toplevel.drvPath`
Run: `nix flake check --print-build-logs`
Expected: both PASS.

- [ ] **Step 7: Format and commit**

```bash
nix fmt
git add hosts/paynefield/default.nix hosts/vps/default.nix
git commit -m "feat(backups): enable nightly B2 backups on paynefield and vps"
```

- [ ] **Step 8: Post-deploy verification (HUMAN, after merge reaches the hosts)**

On paynefield:

```bash
ls /mnt/secure/nas/immich/backups        # spec's Immich verify: dumps must exist
systemctl list-timers | grep restic       # timer present, next run 04:00
sudo systemctl start restic-backups-host  # manual first run
sudo restic-host snapshots                # wrapper installed by the restic module
systemctl is-active container@jellyfin    # running again after the run
```

Expected: the snapshot lists `/mnt/secure/nas/immich/backups`, `/var/lib/vikunja-dumps/vikunja.dump`, the jellyfin dir and `/var/lib/adguardhome-data`. If the Immich dir is empty, report back — the pg_dump-timer fallback from Task 3's note becomes a follow-up task.

On vps: same pattern; snapshot lists the teamspeak dir; `systemctl is-active container@teamspeak` after.

Restore drill (once): `sudo nixos-container root-login vikunja`, then as postgres: `createdb vikunja_drill && pg_restore -d vikunja_drill /var/lib/postgresql/dumps/vikunja.dump && dropdb vikunja_drill`.
Expected: pg_restore exits 0.
