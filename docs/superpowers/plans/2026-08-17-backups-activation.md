# Backups: activate mine.backups and settle the remaining state

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged-but-inert `mine.backups` system (2026-08-14 plan,
Tasks 1–5, now merged as PR #105) actually ship: B2 credentials, sops
secrets, host wiring for paynefield and vps, and post-deploy verification.
Also settle every remaining piece of state with an explicit decision, so
"how is X backed up?" has an answer for every service in this repo.

**Context:** PR #105 added the `mine.backups` module and the per-service
registrations (immich dump dir, vikunja dump, jellyfin sqlite, teamspeak
sqlite, adguard yaml). All of it is guarded on `mine.backups.enable`, which
no host sets — so nothing runs today. Stalwart's bespoke
`services.restic.backups.stalwart` job on vps is live and untouched. This
plan is the rest of the 2026-08-14 plan (its Tasks 6–8, renumbered) plus a
state inventory and the deferrals it recorded.

**Tech Stack:** NixOS, sops-nix, restic, B2, 1Password.

**Spec:** `docs/superpowers/specs/2026-08-14-backups-module-design.md`

## Global Constraints

- Formatter: run `nix fmt` before every commit; CI rejects unformatted files.
- Comments explain *why*, never narrate the change or the next line (repo comment-style spec).
- Verification command for code tasks: `nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath`; full `nix flake check --print-build-logs` before the final commit.
- Repo commit style: `feat(scope): ...` / `chore(scope): ...`.
- Task 1 is HUMAN-ONLY. Task 2 cannot evaluate until Task 1 is done (sops-nix asserts at eval time that referenced keys exist in the yaml).
- All work on a feature branch.

---

## State inventory (post-#105)

The decision for every stateful thing in this repo, after this plan lands:

| State | Host | What's irreplaceable | Coverage |
|---|---|---|---|
| Immich DB dumps | paynefield | albums, favorites, faces, sharing, shares | B2 nightly — the built-in 02:00 pg_dump dir (NAS-mounted) is re-shipped by `restic-backups-host` |
| Immich photo blobs | NAS | the photos themselves | NAS-only by design; the NAS's own backup is unmanaged by this repo and out of scope |
| Vikunja DB | paynefield | tasks, notes | B2 nightly — `-Fc` dump surfaced on the host at `/var/lib/vikunja-dumps` |
| Jellyfin sqlite | paynefield | users, watch state | B2 nightly — raw copy, container stopped during the run |
| AdGuard yaml | paynefield | admin hash, custom rules, client names | B2 nightly — live copy |
| TeamSpeak sqlite | vps | server identity | B2 nightly — raw copy, container stopped during the run |
| Stalwart data dir | vps | ALL DB-managed mail config (ACME, domains, accounts, aliases) and the mail store (`storage.blob = "db"`) | Bespoke restic job to `b2:spacefunk-mail-backups:stalwart`, twice daily (00:00/12:00) — unchanged |
| Terraria worlds | paynefield | `beefcake.wld` game world | **None — decision: not needed** (user, 2026-08-17). Casual game world; low irreplaceable value |
| CUPS printer config | paynefield | configured printers | None — printers re-add in minutes via the web interface; not worth a backup path |
| devbox hosts (redtruck, t495, elitebook, mac) | — | nothing host-service-level (encode_queue is a user tool, jellybox is a stateless kiosk client, worktrees are GitHub-backed) | None. Adding one later is an enable plus two secrets |
| NAS (photo blobs, homes, media) | NAS hardware | the media library | NAS's own backup — out of scope, unmanaged by this repo, unverifiable from here |
| Host age keys | all | sops decryption | None by design — recovery is re-keying `.sops.yaml` for the rebuilt host |
| local-llm / open-webui DB | (module exists, no host enables it) | would be: open-webui sqlite | None today — module is dormant. Revisit if a host enables it; the dump strategy applies |

---

## Out of scope (decisions, with reasons)

- **Terraria** — `mine.system.terraria-server` on paynefield, state at
  `/var/lib/terraria-data` (worlds at `worlds/beefcake.wld`). Explicit
  decision: no backup needed. If that changes later, it is a one-line
  registration (`paths = [ "/var/lib/terraria-data" ]`, no stop — worlds
  are written by the game process while the server runs, so use the
  dump-or-accept-torn-copy judgment call like AdGuard).
- **Immich media** — blobs stay on the NAS; the NAS backup is the owner of
  photo safety. B2 carries only the DB dumps.
- **The NAS itself** — not managed by this repo; unverifiable from here.
- **Host age keys** — loss means re-provision via disko and re-keying
  `.sops.yaml`; repo passwords live in 1Password as the out-of-band copy.
- **Stalwart migration onto `mine.backups`** — see Task 4; default is to
  leave it as-is.
- **Backup alerting and restore automation** — v2 candidates (Task 5).

---

### Task 1: HUMAN — B2 buckets, passwords, sops secrets

Carried over verbatim from the 2026-08-14 plan (Task 6). No code. The
executor STOPS here and hands this checklist to the human; Task 2 cannot
evaluate until it is done.

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

### Task 2: Host wiring

Carried over from the 2026-08-14 plan (Task 7, Steps 1–7).

**Files:**
- Modify: `hosts/paynefield/default.nix` (sops secrets next to `vikunja-jwt-secret` ~line 16; `backups` block inside the existing `mine = { ... }` attrset)
- Modify: `hosts/vps/default.nix` (sops secrets next to the stalwart ones ~line 43; `backups` block inside `mine = { ... }`)
- Test: evaluation + post-deploy checks

**Interfaces:**
- Consumes: everything from Task 1. Secret names must match Task 1 exactly: `restic-b2-env`, `restic-repo-password`.

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

---

### Task 3: Post-deploy verification (HUMAN, after Task 2 reaches the hosts)

Carried over from the 2026-08-14 plan (Task 7, Step 8).

On paynefield:

```bash
ls /mnt/secure/nas/immich/backups        # Immich check: dumps must exist
systemctl list-timers | grep restic       # timer present, next run 04:00
sudo systemctl start restic-backups-host  # manual first run
sudo restic-host snapshots                # wrapper installed by the restic module
systemctl is-active container@jellyfin    # running again after the run
```

Expected: the snapshot lists `/mnt/secure/nas/immich/backups`,
`/var/lib/vikunja-dumps/vikunja.dump`, the jellyfin dir and
`/var/lib/adguardhome-data`.

**If `/mnt/secure/nas/immich/backups` is empty**, Immich's built-in 02:00
backup is disabled in the instance settings. Either enable it in the Immich
UI (Admin Settings → Backup) or add a Vikunja-style `pg_dump` timer in the
container writing under the `/var/lib/immich-data` bind — that fallback is
a follow-up task, not part of this plan.

On vps: same pattern; the snapshot lists the teamspeak dir;
`systemctl is-active container@teamspeak` after the run. Also confirm
Stalwart's job is untouched: `systemctl list-timers | grep restic-stalwart`
still shows 00:00/12:00.

Restore drill (once): `sudo nixos-container root-login vikunja`, then as
postgres: `createdb vikunja_drill && pg_restore -d vikunja_drill
/var/lib/postgresql/dumps/vikunja.dump && dropdb vikunja_drill`.
Expected: pg_restore exits 0.

---

### Task 4 (OPTIONAL — decide before starting): migrate Stalwart onto mine.backups

The 2026-08-14 spec deferred this: "Migrating it onto the module is a
possible later cleanup, not part of this work." Default: **do not do it
yet**. The analysis, for whoever decides:

**What migration means:** vps's `mine.backups` job (one per host) would take
over `/var/lib/stalwart-data` with `stopContainers = [ "stalwart" ]`, and
Stalwart's bespoke `services.restic.backups.stalwart` job goes away.

**Costs:**
- **Schedule:** the shared job runs once daily at 04:00; Stalwart runs
  twice daily. Stalwart's store holds not just config but the mail blobs
  (`storage.blob = "db"` — mail data lives in the same RocksDB), so
  migration changes the RPO for mail from ~12h to ~24h.
- **Repository:** Stalwart's snapshots live in
  `b2:spacefunk-mail-backups:stalwart`; the host job writes
  `b2:spacefunk-vps-backups:vps`. Migration orphans the old repository
  (keep it read-only for a while, or `restic copy` history over).
- **Benefit:** one mechanism, one pattern, less bespoke code — the only gain.

**If the decision is to migrate**, the steps are: add
`/var/lib/stalwart-data` + `stopContainers = [ "stalwart" ]` to vps's
`mine.backups` (via the stalwart module's registration block, guarded like
the others), remove the bespoke `services.restic.backups.stalwart` block and
its `backup` options from `modules/stalwart-server/nixos.nix`, drop the now
unused `restic-stalwart-*` sops declarations from
`hosts/vps/default.nix`, deploy, verify a snapshot of the dir appears in the
vps repo, and leave the old mail-backups bucket in place until the history
is no longer needed.

---

### Task 5: v2 parking lot

Not planned. Tracked so these decisions aren't rediscovered:

- **Alerting** — a failed restic run is only visible in `systemctl --failed`.
- **Restore runbook** — the module header documents the commands; a tested,
  per-service runbook (including the Stalwart repo) would be the next doc.
- **Devbox host enablement** — the pattern is ready: `mine.backups.enable`
  + two secrets per host. No host currently has service state worth it.
- **local-llm / open-webui** — dormant module; if a host enables it,
  register its open-webui sqlite with the stop strategy.
- **Stalwart migration** — Task 4.
