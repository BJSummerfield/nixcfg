# Backups: activate mine.backups and settle the remaining state

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged-but-inert `mine.backups` system (2026-08-14 plan,
Tasks 1–5, now merged as PR #105) actually ship: B2 credentials, sops
secrets, host wiring for paynefield and vps, and post-deploy verification —
with the bucket Object-Locked (60-day governance retention, 2026-08-20
decision) and Stalwart's bespoke job migrated onto the shared module.
Also settle every remaining piece of state with an explicit decision, so
"how is X backed up?" has an answer for every service in this repo.

**Context:** PR #105 added the `mine.backups` module and the per-service
registrations (immich dump dir, vikunja dump, jellyfin sqlite, teamspeak
sqlite, adguard yaml). All of it is guarded on `mine.backups.enable`, which
no host sets — so nothing runs today. Stalwart's bespoke
`services.restic.backups.stalwart` job on vps is live; this plan retires it
in the same deploy that enables the shared job (2026-08-20 amendment — the
original "leave it as-is" deferral is superseded, see Task 4). This
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
| Stalwart data dir | vps | ALL DB-managed mail config (ACME, domains, accounts, aliases) and the mail store (`storage.blob = "db"`) | B2 nightly via the vps `mine.backups` job — raw copy, container stopped during the run. Migrated off the bespoke twice-daily job by this plan; RPO 12h→24h accepted 2026-08-20 (mail barely used). Old `b2:spacefunk-mail-backups:stalwart` repo kept read-only until the vps repo holds ~60 days of history |
| Terraria worlds | paynefield | `beefcake.wld` game world | **None — decision: not needed** (user, 2026-08-17). Casual game world; low irreplaceable value |
| CUPS printer config | paynefield | configured printers | None — printers re-add in minutes via the web interface; not worth a backup path |
| devbox hosts (redtruck, t495, elitebook, mac) | — | nothing host-service-level (encode_queue is a user tool, jellybox is a stateless kiosk client, worktrees are GitHub-backed) | None. Adding one later is an enable plus two secrets |
| NAS (photo blobs, homes, media) | NAS hardware | the media library | NAS's own backup — out of scope, unmanaged by this repo, unverifiable from here |
| Host age keys | all | sops decryption | None by design — recovery is re-keying `.sops.yaml` for the rebuilt host |
| local-llm / open-webui DB | (module exists, no host enables it) | would be: open-webui sqlite | None today — module is dormant. Revisit if a host enables it; the dump strategy applies |
| Paseo daemon | redtruck | session history, config.json; worktrees under `/var/lib/paseo/worktrees` | **None — decision: skip** (2026-08-17). Worktrees are bind-mounted git content — protection is pushing, not restic. Session state is disposable. Cost of covering it = a third B2 bucket + per-host secrets |
| Tailscale node state | all hosts | per-container node identity (`/var/lib/tailscale-*`) | **None — re-runnable.** Every module's bring-up comment documents its `tailscale up --advertise-tags=...`; worst case is re-approving a tagged node in the tailnet admin UI |
| Steam saves / personal data | redtruck, t495, elitebook, mac | game saves, browser profiles | Outside this repo's convention (spec: devbox hosts out). Owner: personal; Steam Cloud covers what it covers |

---

## Scope decisions (2026-08-17 scoping conversation)

The reduced mental model is "jellyfin db, immich db, stalwart". The
inventory above is the complete list; the deltas:

- **Cost is per host, not per path.** The paynefield job runs for immich +
  jellyfin whether or not vikunja and adguard ride along, so skipping them
  saves nothing (a few MB of dumps per night) and would mean editing
  registrations already merged in #105. **Vikunja and AdGuard stay, for
  free.**
- **In the reduced scope, the only content of the vps `mine.backups` job is
  TeamSpeak** — Stalwart is already covered by its own bespoke job. That is a
  *decision, not an oversight*: the teamspeak sqlite is server identity
  (losing it forces every client to re-trust a new server), and it costs zero
  if the vps job runs. If the call is "no vps bucket at all", TeamSpeak is
  uncovered — say so explicitly rather than by silence. **Default: keep.**
- **Paseo is skipped** — the daemon (devbox container on redtruck) holds
  session history and worktrees that are bind-mounted git content; not an
  always-on server, and the per-host cost (third bucket + key + password +
  secrets) buys nothing irreplaceable. Pushed work is already safe; unpushed
  work is a git-hygiene problem, not a backup problem.
- **Tailscale node state is skipped** — re-runnable via the documented
  bring-up commands; the failure mode is re-approving tagged nodes, which is
  friction, not data loss.
- **Single B2 bucket, one repo per host as a path prefix** (2026-08-17):
  `spacefunk-backups` holds `:paynefield` and `:vps` repos, so the B2 console
  shows every backup under one bucket, split by the host prefix. One app key
  scoped to that bucket; the repos stay separate (own passwords, locks, prune)
  so hosts do not contend on repo locks. A single *shared* repo for both
  hosts was rejected: restic locks the repo during a run, so same-hour runs
  would collide, and one host's prune would govern the other's history. Trade
  accepted: any host with the app key can read the whole bucket — all hosts
  and all data are the same owner. ~~Stalwart's live `b2:spacefunk-mail-backups:stalwart`
  repo is left as-is~~ — superseded 2026-08-20, see the Stalwart bullet below.
- **Object Lock, 60-day governance retention** (2026-08-20): the bucket is
  created with Object Lock enabled (creation-time only — it cannot be added
  later) and a default retention of 60 days in **governance** mode, plus a
  lifecycle rule keeping prior file versions 60 days, plus an app key
  **without** `deleteFiles`. Three layers, each covering the others' gap:
  the lock stops hard version-deletes for 60 days from upload; the lifecycle
  rule keeps anything *hidden* recoverable for 60 days regardless of lock
  age; the delete-less key means even packs whose lock has expired cannot be
  hard-deleted with stolen host credentials. Governance over compliance:
  the master account keeps a break-glass bypass for misconfiguration, while
  the scoped app key (no `bypassGovernance`) gets no such power. Consequence
  for restic: repos move to B2's S3-compatible endpoint (`s3:` URLs, AWS-style
  env vars); restic needs no object-lock awareness — its deletes become
  version-hides, and disk space from a prune reclaims ~60 days later instead
  of immediately (pennies at these sizes).
- **Stalwart migrates onto `mine.backups`** (2026-08-20, promoted from the
  optional Task 4): the bespoke twice-daily job and its `restic-stalwart-*`
  secrets are removed in the same commit that enables the shared job on vps,
  so the handoff is one atomic deploy with no backup-less gap. Accepted
  trade-offs: mail RPO 12h → 24h (mail barely used), and Stalwart is stopped
  for a few minutes at 04:00 (SMTP senders retry; nothing is lost). The old
  `spacefunk-mail-backups` bucket stays untouched as read-only history —
  delete it manually once the new repo has ~60 days of snapshots. No
  `restic copy`.

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
- **Backup alerting and restore automation** — v2 candidates (Task 5).
- **Paseo daemon state** (redtruck) — see scope decisions above.
- **Tailscale node state** — re-runnable; see scope decisions above.
- **Steam saves / personal data on the desktop and box hosts** — personal
  ownership, outside this repo's convention.

---

## Execution protocol (who does what, in what order)

Three actors: you, the agent (executor), and the hosts (auto-upgrade).

1. **You — Task 1, end to end.** B2 console + CLI (object-locked bucket,
   lifecycle rule, scoped app key), 1Password (two passwords),
   `sops secrets/hosts/{paynefield,vps}.yaml` (two keys per
   host), commit + push. This is the only part the agent *cannot* do, for two
   reasons: the values live in your B2 account and 1Password, and sops
   re-encryption needs your age key, which the agent's container does not
   have (host secrets are not available to it).
2. **Handoff signal.** You commit and say "Task 1 done" (or just tell the
   agent and let it verify). The agent checks that `restic-b2-env` and
   `restic-repo-password` exist in both host yamls. Until then, Task 2's
   eval is intentionally red — that is the plan working, not a bug.
3. **Agent — Task 2.** Branch from the main that includes your secrets
   commit, run the TDD steps (enable → red eval → declare secrets → green
   eval → `nix flake check`), migrate Stalwart onto the shared job in the
   same branch, open the PR. The module doc polish (S3-form `repository`
   example, env-var description) rides along.
4. **You — merge Task 2's PR.** Both hosts have `autoUpgrade.enable = true`,
   so the config reaches paynefield and vps on their next auto-upgrade; no
   manual `nixos-rebuild` is needed unless you want it immediately.
5. **You — Task 3, on each host.** Run the verification commands; paste
   output back to the agent if anything is unexpected. The one check with a
   real branch is the Immich dump dir: empty → either enable Immich's
   built-in backup in the UI or file the pg_dump-timer follow-up.

**Commit placement:** Task 1's sops commit goes to main first (direct or a
small `chore(secrets)` PR — your call; the repo's convention is PRs, but a
secrets-only commit is trivial to review). Task 2's branch bases on top of
it. Alternative: sops edit and host wiring on one branch — the branch head
evaluates green even though the intermediate commit does not; two commits
in sequence keep each step individually green and are the recommended shape.

**What the agent cannot do in this plan:** create the B2 resources,
hold the 1Password values, re-encrypt sops, or reach the hosts for Task 3
verification. Everything else is agent-executable.

---

### Task 1: HUMAN — object-locked B2 bucket, passwords, sops secrets

Based on the 2026-08-14 plan (Task 6), amended 2026-08-17 to a single shared
bucket and 2026-08-20 to Object Lock + S3 endpoint (see scope decisions).
No code. The executor STOPS here and hands this checklist to the human;
Task 2 cannot evaluate until it is done.

- [ ] Create B2 bucket `spacefunk-backups` (private) **with Object Lock enabled at creation** — it cannot be turned on later; if the bucket already exists without it, delete and recreate. Set the bucket's default retention: **governance mode, 60 days**.
- [ ] Lifecycle Settings on the bucket: **keep prior versions for 60 days** (`daysFromHidingToDeleting = 60`).
- [ ] Create ONE application key scoped to only that bucket, **without `deleteFiles`**. The console only offers canned capability sets, so use the CLI: `b2 key create --bucket spacefunk-backups spacefunk-backups-restic listBuckets,listFiles,readFiles,writeFiles`
- [ ] Note the bucket's S3 endpoint from its details page (`s3.<region>.backblazeb2.com`) — the repo URLs in Task 2 need it.
- [ ] Generate two restic repo passwords (e.g. `openssl rand -base64 32`), one per host. **Store both in 1Password** — the sops copies die with the host disks. The bucket is shared, but the repos are not: `paynefield/` and `vps/` are separate restic repositories under path prefixes inside the one bucket, each with its own password, locks, and prune. Stalwart rides the vps repo — no third password.
- [ ] `sops secrets/hosts/paynefield.yaml` — add:
  - `restic-b2-env`: multiline value `AWS_ACCESS_KEY_ID=<keyID>` newline `AWS_SECRET_ACCESS_KEY=<applicationKey>` (the B2 key pair used as S3 credentials — restic's `s3:` backend reads AWS-style vars)
  - `restic-repo-password`: the paynefield password
- [ ] `sops secrets/hosts/vps.yaml` — add the same two keys with the vps password (same app key).
- [ ] Commit the re-encrypted yaml files:

```bash
git add secrets/hosts/paynefield.yaml secrets/hosts/vps.yaml
git commit -m "chore(secrets): restic B2 credentials for paynefield and vps"
```

---

### Task 2: Host wiring + Stalwart migration

Carried over from the 2026-08-14 plan (Task 7, Steps 1–7), extended
2026-08-20 with the Stalwart migration so the bespoke job's removal and the
shared job's enablement land in one deploy — no backup-less gap for mail.

**Files:**
- Modify: `hosts/paynefield/default.nix` (sops secrets next to `vikunja-jwt-secret` ~line 16; `backups` block inside the existing `mine = { ... }` attrset)
- Modify: `hosts/vps/default.nix` (sops secrets next to the stalwart ones ~line 43; `backups` block inside `mine = { ... }`; remove the `restic-stalwart-*` sops declarations and the stalwart `backup = { ... }` block)
- Modify: `modules/stalwart-server/nixos.nix` (remove the `backup` options and the bespoke `services.restic.backups.stalwart` job; add the guarded `mine.backups` registration)
- Modify: `modules/backups/nixos.nix` (doc polish: S3-form `repository` example, AWS-style env vars in the `b2EnvFile` description and header comment)
- Test: evaluation + post-deploy checks

**Interfaces:**
- Consumes: everything from Task 1. Secret names must match Task 1 exactly: `restic-b2-env`, `restic-repo-password`.

- [ ] **Step 1: Write the failing eval test — enable before declaring secrets**

In `hosts/paynefield/default.nix`, inside the `mine = { ... }` attrset (sibling of `system`), add only:

```nix
    backups = {
      enable = true;
      repository = "s3:s3.<region>.backblazeb2.com/spacefunk-backups/paynefield";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
    };
```

(`<region>` is the endpoint noted in Task 1, e.g. `us-west-004`.)

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
      repository = "s3:s3.<region>.backblazeb2.com/spacefunk-backups/vps";
      b2EnvFile = config.sops.secrets.restic-b2-env.path;
      repoPasswordFile = config.sops.secrets.restic-repo-password.path;
    };
```

- [ ] **Step 6: Migrate Stalwart onto the shared job**

In `modules/stalwart-server/nixos.nix`:
- Remove the whole `backup = { ... }` option set and the bespoke
  `services.restic.backups.stalwart` block.
- Add the same guarded registration the other services use (the module
  already has `hostStateDir` in scope):

```nix
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "stalwart" ];
    };
```

In `hosts/vps/default.nix`: remove the `sops.secrets.restic-stalwart-b2-env`
and `sops.secrets.restic-stalwart-repo-pw` declarations and the
`backup = { ... }` block inside `stalwart-server` (keep `adminPasswordFile`).

- [ ] **Step 7: Run the full check**

Run: `nix eval --raw .#nixosConfigurations.vps.config.system.build.toplevel.drvPath`
Run: `nix flake check --print-build-logs`
Expected: both PASS.

- [ ] **Step 8: Doc polish in `modules/backups/nixos.nix`**

Update the `repository` example to the S3 form
(`s3:s3.<region>.backblazeb2.com/spacefunk-backups/paynefield`) and the
`b2EnvFile` description + module header comment to the AWS-style variables
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) — with the S3 endpoint they
are no longer B2-native names, and a stale description here would send a
future restore down the wrong env-var path.

- [ ] **Step 9: Format and commit**

```bash
nix fmt
git add hosts/paynefield/default.nix hosts/vps/default.nix modules/stalwart-server/nixos.nix modules/backups/nixos.nix
git commit -m "feat(backups): enable object-locked B2 backups; fold stalwart into the host job"
```

(Two commits are also fine — enable then migrate — as long as both are in
the same PR so they deploy together.)

Post-merge cleanup (HUMAN, optional, any time): drop the now-unused
`restic-stalwart-b2-env` / `restic-stalwart-repo-pw` keys from
`secrets/hosts/vps.yaml` via `sops`. Keep the old repo *password* in
1Password until the `spacefunk-mail-backups` bucket is deleted — it is the
only way to read that history.

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

On vps: same pattern; the snapshot lists the teamspeak dir AND
`/var/lib/stalwart-data`; `systemctl is-active container@teamspeak` and
`container@stalwart` after the run. Also confirm the bespoke job is gone:
`systemctl list-timers | grep restic` shows only `restic-backups-host` —
no `restic-stalwart` timer.

**Object-lock / delete-less-key check (both hosts, first run):** the app key
has no `deleteFiles`, so watch the first run's log
(`journalctl -u restic-backups-host`) for errors removing the repo lock
file or from the post-backup forget/prune. Expected: none — under B2's S3
API a restic delete is a version-hide, which the key's `writeFiles` covers.
**If** B2's S3 layer turns out to demand `deleteFiles` for it, recreate the
app key with `deleteFiles` added and move on: Object Lock plus the 60-day
lifecycle rule still guarantee the full recovery window on their own; the
delete-less key was the third, redundant layer.

Restore drill (once): `sudo nixos-container root-login vikunja`, then as
postgres: `createdb vikunja_drill && pg_restore -d vikunja_drill
/var/lib/postgresql/dumps/vikunja.dump && dropdb vikunja_drill`.
Expected: pg_restore exits 0.

---

### Task 4: RESOLVED 2026-08-20 — Stalwart migration folded into Task 2

The 2026-08-14 spec deferred this ("possible later cleanup"); decided
2026-08-20 to do it now, since mail is barely used and consolidating forces
the object-lock setup through in one pass. The costs the original analysis
identified, now accepted:

- **RPO for mail: ~12h → ~24h.** The shared job runs once nightly at 04:00
  instead of twice daily, and Stalwart's store holds the mail blobs, not
  just config (`storage.blob = "db"`).
- **The old repository is orphaned.** `b2:spacefunk-mail-backups:stalwart`
  stays read-only; delete the bucket manually once the vps repo has ~60
  days of history. No `restic copy`.

The migration steps live in Task 2 (Step 6); verification in Task 3.

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
- **NAS repo** — when the future NAS host lands (terabytes of photo blobs),
  it is another `mine.backups.enable` + prefix in the same object-locked
  bucket, but wants its own repo tuning (larger `--pack-size`, separate
  prune cadence) — do not couple it to the app-data repos.
