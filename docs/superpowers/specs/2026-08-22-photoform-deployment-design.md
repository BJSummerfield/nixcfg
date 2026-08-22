# PhotoForm deployment: reconciling the module with the app's shipped contract

## Problem

`modules/photoform/nixos.nix` was written against a contract the app repo was
expected to grow. `BJSummerfield/Sheet-Automation-FF` has since shipped that
work (`deeebae`, PR #3), and it landed a different contract than the one the
module hardcodes. Nothing in nixcfg has been deployed, so the cost is rework
rather than an outage — but every one of the five mismatches below is a
start-time failure, and four of them fail in ways that are hard to read from a
`systemctl status`:

| `modules/photoform/nixos.nix` assumes | `deeebae` provides |
|---|---|
| `PHOTOFORM_*` env vars | `BOOKING_*` |
| five secrets, including `photoform-paypal-client-id` | four; the PayPal client ID is public and belongs in the config file |
| `sops.templates."photoform.env"` carrying values | a `X_FILE` form for every secret, so values stay out of the environment |
| `PHOTOFORM_SHEETS_CREDENTIALS_FILE` | `BOOKING_SHEETS_SERVICE_ACCOUNT_FILE` |
| `ExecStart … --config …/production.toml` | no `--config` flag; the path comes from `BOOKING_CONFIG` |

Two further gaps are not mismatches but absences. No production config file
exists anywhere — the app repo ships `config.example.toml` with placeholder
`client_id` and `spreadsheet_id`, and the module points at a
`$out/share/photoform/production.toml` nothing creates. And the booking
hostname moved to `booking.summerfieldphotography.com` (app commit `071f5fa`),
while the module still routes `booking.arisummerfieldphotography.com` — a
different registered domain, resolving to a different IP.

## Goal

`booking.summerfieldphotography.com` serves the booking form over TLS from
vps, in PayPal sandbox mode, with its sqlite database backed up nightly to B2
and its four credentials arriving from sops without ever entering the app's
process environment. vps compiles nothing. Mail continues to behave exactly as
it does today.

## Decisions

**The production config is baked into the app package.** It holds no
credentials — the app itself enumerates what counts as a secret in
`reject_legacy_secret_keys` (`src/config.rs`), and all four are startup errors
if they appear in the file. What remains is public booking content plus
`paypal.client_id`, which `src/views/form.rs` renders into every page's PayPal
SDK URL anyway. Committing it upstream keeps it out of this public repo and
out of a world-readable store path, and costs a rev bump only when content
changes. The eventual home for this data is a database behind an admin
console; a committed TOML is the cheapest thing to migrate away from.

**The first deploy is PayPal sandbox, and going live is a full redeploy.** No
env override for `paypal.mode` and no second config file. A sandbox/live
toggle is real future work — it belongs with per-site settings in that same
admin console, not as a deployment knob invented now for a single site.

**`sops.templates."photoform.env"` is deleted, not renamed.** The template's
only purpose is to put secret values into the environment, which is precisely
what the app's `X_FILE` form exists to avoid: upstream's `.env.example` states
that production sets only the `_FILE` variables so values never reach
`/proc/<pid>/environ`, `systemctl show`, or a crash dump. Deleting it also
removes the rendering step and the fifth secret.

**`LoadCredential` carries all four secrets across the container boundary.**
`_FILE` pointed straight at a bind mount does not work: sops writes
`0400 root:root`, a bind mount preserves host ownership, and the app runs as an
unprivileged in-container `photoform` user, so all four reads fail with
EACCES. `LoadCredential` copies as root into a per-unit tmpfs owned by `User=`.
The module already does this for the Sheets JSON; the change generalizes the
existing solution rather than introducing one. Credential paths are written as
literal `/run/credentials/photoform.service/<name>` rather than `%d`,
following the ruling already recorded in the module's comments.

**Hashes are discovered locally, not by CI ping-pong.** Neither hash requires
the private fetch to succeed. `cargoHash` is a fixed-output hash of the vendor
directory, determined by `Cargo.lock` alone, so building a scratch copy of the
derivation against a local checkout produces the same value. `sha256` is the
NAR hash of the unpacked tree, which `nix hash path` over a `git archive`
export reproduces. The method is validated against the known-good
`sha256-goPjgkUrh/fGjb//G4JJlV/FjgywGeenhDqv35nPU9k=` recorded for `306b3a8`
on `feat/photoform-package` before it is trusted for `deeebae`; if that
cross-check fails, the fallback is a fake-hash PR whose CI failure prints the
expected value.

## Scope

In scope:

- One app-repo commit adding `config/production.toml`.
- `modules/photoform/package.nix` — rev, both hashes, `postInstall`.
- `modules/photoform/nixos.nix` — secrets plumbing, config path, hostname.
- `flake.nix` — `photoform` in `packages`.
- `secrets/hosts/vps.yaml` — four `photoform-*` secrets.
- `hosts/vps/default.nix` — enable the module.
- A DNS A record for the booking subdomain.
- Proving the existing restic registration actually captures the database.

Out of scope:

- **The missing-data-directory bug** (below). It affects local development
  only and is fixed upstream, separately.
- The sandbox-to-live PayPal flip, which is a later redeploy.
- Anything touching Stalwart, the caddy edge module, or `mine.backups`. All
  three are live and correct; this work consumes them.

## Approach

### Package

The rev moves `4ed5a58` to `352b89a` and both hashes change with it. One
addition installs the config, which cargo has no reason to install on its own:

```nix
postInstall = ''
  install -Dm444 config/production.toml $out/share/photoform/production.toml
'';
```

This same change adds `passthru.cache = true`, so CI pushes the closure to
`s3://spacefunk-nix-cache` once the attribute is in `packages`.
`feat/photoform-package` adds that same line to `flake.nix`: expect a conflict
and keep both attributes.

### Module

Four sops secrets (`photoform-paypal-client-secret`, `photoform-smtp-password`,
`photoform-admin-password`, `photoform-sheets-sa`), each bind-mounted read-only
into the container, each loaded as a systemd credential, each named to the app
through its `_FILE` variable:

```nix
LoadCredential = [
  "paypal-client-secret:/run/host-secrets/photoform-paypal-client-secret"
  "smtp-password:/run/host-secrets/photoform-smtp-password"
  "admin-password:/run/host-secrets/photoform-admin-password"
  "sheets-sa:/run/host-secrets/photoform-sheets-sa"
];
environment = {
  BOOKING_CONFIG = "${photoform}/share/photoform/production.toml";
  BOOKING_PAYPAL_CLIENT_SECRET_FILE = "/run/credentials/photoform.service/paypal-client-secret";
  BOOKING_SMTP_PASSWORD_FILE = "/run/credentials/photoform.service/smtp-password";
  BOOKING_ADMIN_PASSWORD_FILE = "/run/credentials/photoform.service/admin-password";
  BOOKING_SHEETS_SERVICE_ACCOUNT_FILE = "/run/credentials/photoform.service/sheets-sa";
};
```

`ExecStart` drops `--config` and becomes the bare binary. The caddy route's
hostname becomes `booking.summerfieldphotography.com`. Everything else in the
module — the container, its private network and NAT, the tmpfiles rule, the
backup registration, the assertion that the caddy edge is present — is
unchanged.

### Config

`config/production.toml` is the working development config with three lines
changed: `bind = "0.0.0.0:8080"`, `public_url =
"https://booking.summerfieldphotography.com"`, and an absolute
`database_url = "sqlite:///var/lib/photoform/booking.db?mode=rwc"`.
`mode = "sandbox"` and the sandbox `client_id` stay as they are.

### DNS

An `A` record, host `booking`, value `178.104.51.195` (vps, confirmed as the
address `mx1.brianjs.com` resolves to), short TTL. Not a URL-redirect record —
ACME HTTP-01 and TLS both need the name to resolve to the address. No `AAAA`:
vps answers on IPv4 only, and a stale `AAAA` makes v6-preferring clients fail
rather than fall back. Nothing else in the zone may claim `booking`, since a
CNAME cannot coexist with an A record on one name.

Before the deploy, the name resolves to a vps whose edge is fallback-only, so
a browser gets Stalwart's certificate and a name mismatch. That is the edge's
designed fail-open behavior, not a misconfiguration.

### Rollout

Each step is gated on the one before it:

1. Commit `config/production.toml` upstream; record the rev.
2. Package rev, hashes, `postInstall`, and the `flake.nix` attribute; CI
   builds and pushes the closure.
3. **Gate:** vps substitutes the package from the cache. Compilation output
   here stops the rollout.
4. The four secrets are added to `secrets/hosts/vps.yaml` by hand, by someone
   holding an age key.
5. The module rewrite and the host enable; CI green, blast radius zero.
6. Deploy from `verified`.
7. Functional verification, then the mail regression battery.
8. Prove the backup captures the database.

## Failure modes

**A live PayPal client ID under `mode = "sandbox"`.** The app validates that
`mode` is one of two strings and derives its API base from it, but never
checks that the client ID belongs to the same environment. Startup succeeds
and the failure appears at capture time, with a real buyer waiting. Mitigated
by confirming the ID came from the Sandbox tab, and by taking a sandbox
booking end-to-end before announcing the URL.

**A secret that is unreadable rather than absent.** The app reports every
missing or empty secret in one startup error, which is a good failure. A
`LoadCredential` misconfiguration instead surfaces as a path that could not be
read — check `/run/credentials/photoform.service/` inside the container before
suspecting sops.

**A stale secret after rotation.** The container's bind mounts resolve at
start, so re-encrypting a secret without restarting the container leaves the
old value in place. Upstream documents this: rotating a credential means a
restart.

**The database in the wrong place.** A relative `database_url` would resolve
against `WorkingDirectory` and land in a directory tmpfiles does not create,
producing the same 30-second stall described below. The absolute path is
checked directly after the first start.

**Backups that silently capture nothing.** `mine.backups` asserts only that
some path was registered, not that anything exists at it. A restic snapshot is
listed and inspected rather than assumed.

**The missing-data-directory bug (development only).** sqlx 0.8.6's
`SqliteConnectOptions::from_str` strips the `sqlite://` prefix and treats the
remainder as a path, so `sqlite://data/booking.db` is relative to the process's
working directory. `create_if_missing` maps to `SQLITE_OPEN_CREATE`, which
creates the file but never its parent directory, so a fresh clone fails with
`SQLITE_CANTOPEN`; the apparent hang is `SqlitePoolOptions`' 30-second acquire
timeout. Production is immune because the container's tmpfiles rule creates
`/var/lib/photoform` before the unit starts. The upstream fix is a
`create_dir_all` on the parent in `db::connect`.

## Verification

- `nix hash path` reproduces `sha256-goPjgkUrh/…` for `306b3a8` — the
  precondition for trusting the offline hash method.
- On vps: `nix build --no-link --print-build-logs github:BJSummerfield/nixcfg/verified#photoform`
  prints `copying path … from 's3://spacefunk-nix-cache…'` and no rustc output.
- `nix flake check` passes, including `caddyfile-vps` adapting the rendered
  config with the real binary.
- The other four hosts' `system.build.toplevel.drvPath` values are unchanged.
- `getent ahosts booking.summerfieldphotography.com` returns `178.104.51.195`.
- The form loads over HTTPS with a certificate naming the booking host.
- A sandbox booking completes end-to-end: PayPal capture, a row in the sheet,
  a confirmation email.
- `/admin` rejects a wrong password and accepts the sops one.
- `/var/lib/photoform/booking.db` exists inside the container and
  `/var/lib/photoform-data/booking.db` exists on the host.
- The mail regression battery passes: known mail SNI reaches Stalwart's own
  certificate, mail flows in both directions, JMAP answers, webadmin loads.
- A hand-run restic backup lists a snapshot containing `booking.db`, and the
  container is running again afterwards.

## Success criteria

A parent can open `https://booking.summerfieldphotography.com`, book a slot
with a PayPal sandbox account, and receive a confirmation email; the booking
appears in the Google sheet and in a restic snapshot the following morning;
vps never compiled anything to make that true; and mail is exactly as it was.
