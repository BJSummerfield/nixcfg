# PhotoForm Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `booking.summerfieldphotography.com` from vps in PayPal sandbox mode, with the module reconciled against the contract the app repo actually shipped, the package substituted from the private cache, four credentials delivered by sops, and the sqlite database proven to land in a restic snapshot.

**Architecture:** The app repo gains one committed `config/production.toml` that the nixcfg package installs to `$out/share/photoform/production.toml`. The module stops rendering a sops env template and instead bind-mounts four sops files, loads each as a systemd credential, and names them to the app through `BOOKING_*_FILE` variables — so no secret value ever enters the process environment. A pure-evaluation flake check pins the module to the app's contract so this class of drift fails in CI rather than at `systemctl start`.

**Tech Stack:** Rust 2021 (`sqlx` 0.8.6 / sqlite, `axum`, `toml` 0.8), NixOS (nixpkgs-unstable), `rustPlatform.buildRustPackage` with `fetchFromGitHub { private = true; }`, sops-nix, systemd-nspawn containers, systemd `LoadCredential`, Caddy + `caddy-l4` SNI edge, restic to Backblaze B2.

**Spec:** `docs/superpowers/specs/2026-08-22-photoform-deployment-design.md`

## Global Constraints

- Env var names, verbatim — these are the app's, not ours: `BOOKING_CONFIG`, `BOOKING_PAYPAL_CLIENT_SECRET_FILE`, `BOOKING_SMTP_PASSWORD_FILE`, `BOOKING_ADMIN_PASSWORD_FILE`, `BOOKING_SHEETS_SERVICE_ACCOUNT_FILE`. There is no `--config` flag; the config path travels in `BOOKING_CONFIG`.
- sops secret names, verbatim: `photoform-paypal-client-secret`, `photoform-smtp-password`, `photoform-admin-password`, `photoform-sheets-sa`. There is **no** `photoform-paypal-client-id` — the PayPal client ID is public and lives in the config file.
- Booking hostname: `booking.summerfieldphotography.com`. Not `arisummerfieldphotography.com`, which is a different registered domain.
- Container name `photoform` (≤ 11 chars for the `ve-` veth), hostAddress `192.168.100.50`, localAddress `192.168.100.51`, app port `8080`. Host state dir `/var/lib/photoform-data`, container state dir `/var/lib/photoform`. Binary is `nesting-box-booking`; the package attr is `photoform`.
- vps has ~1 GB of RAM and cannot compile this package or caddy-with-l4. Both carry `passthru.cache = true`; anything vps needs must arrive substituted. Cache store string: `s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005`.
- **Fail-open toward mail.** vps's caddy `fallback` is Stalwart's container 443 (`192.168.100.41:443`). A route mistake breaks the booking site, never mail.
- Run `nix fmt` before committing any `.nix` change (the formatter is nixfmt-tree). Comments state the reason in one sentence, lead with the conclusion, carry no history and no cross-references.
- **Blast radius.** Every task touching a shared module ends by proving the other hosts' toplevel drvPaths are unchanged. Capture "before" values at the start of the task:
  ```bash
  for h in elitebook paynefield redtruck t495 vps; do
    printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
  done
  ```
- Deploy flow: merge to `main` → CI green → `verified` advances → on vps `sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified`.
- The nixcfg repo is **public**. No credential, and nothing worth hiding, may land in it.

## Prerequisite: DNS

Not a task — done by hand in the Namecheap console, and only Task 6's deploy depends on it.

`A` record, host `booking` (that string alone; the console appends the domain), value `178.104.51.195`, TTL 5 minutes. Not a URL-redirect record: ACME HTTP-01 and TLS both need the name to resolve to the address. No `AAAA` — vps answers on IPv4 only, and a stale `AAAA` makes v6-preferring clients fail rather than fall back. Nothing else in the zone may claim `booking`; a CNAME cannot coexist with an A record on one name.

Verify:

```bash
getent ahosts booking.summerfieldphotography.com
```

Expected: `178.104.51.195`. Before Task 6 deploys, visiting the name returns Stalwart's certificate with a name mismatch — that is the edge's designed fail-open behavior, not a fault.

## File Structure

| File | Responsibility |
|---|---|
| `BJSummerfield/Sheet-Automation-FF: config/production.toml` | **Create.** The deployed content: event, windows, pricing, sandbox PayPal, sheet ID, production bind/URL/database path. No credentials. |
| `BJSummerfield/Sheet-Automation-FF: tests/production_config.rs` | **Create.** Proves that file parses, validates, and holds the production invariants the module depends on. |
| `modules/photoform/package.nix` | **Modify.** New rev, both hashes, `postInstall` installing the config into `$out/share/photoform/`. |
| `flake.nix` | **Modify.** `photoform` in `packages` (CI builds it and pushes it to the cache) and `photoform` in `checks` (the new eval test). |
| `tests/photoform.nix` | **Create.** Pure-evaluation assertions binding the module to the app's contract. |
| `modules/photoform/nixos.nix` | **Modify.** Delete the sops template, four secrets not five, `LoadCredential` for all four, `BOOKING_*` environment, `BOOKING_CONFIG` instead of `--config`, corrected route hostname. |
| `secrets/hosts/vps.yaml` | **Modify.** Four new `photoform-*` secrets. |
| `hosts/vps/default.nix` | **Modify.** Enable `mine.system.photoform`. |

---

## Task 1: Commit the production config upstream

Work in the app repo checkout at `/tmp/Sheet-Automation-FF` (currently on `main` at `deeebae`). This is the only task outside nixcfg.

**Files:**
- Create: `/tmp/Sheet-Automation-FF/config/production.toml`
- Create: `/tmp/Sheet-Automation-FF/tests/production_config.rs`

**Interfaces:**
- Consumes: `nesting_box_booking::config::Config::load_with_secrets(&Path, Secrets) -> Result<Config>` and `nesting_box_booking::secrets::Secrets::example() -> Secrets`, both already public.
- Produces: a git rev (Task 2 pins it) and the store-relative path `share/photoform/production.toml` (Task 2 installs it, Task 5 asserts it).

- [ ] **Step 1: Write the failing test**

Create `/tmp/Sheet-Automation-FF/tests/production_config.rs`:

```rust
//! `config/production.toml` is what nixcfg installs into the nix store and
//! names through BOOKING_CONFIG. A parse or validation failure there is a
//! service that will not start on the VPS, so it is caught here instead of
//! at deploy time.

use nesting_box_booking::config::Config;
use nesting_box_booking::secrets::Secrets;
use std::path::Path;

/// Example secrets, never real ones: this file is checked for what it says
/// about deployment, and the four credentials deliberately are not in it.
fn production() -> Config {
    Config::load_with_secrets(Path::new("config/production.toml"), Secrets::example())
        .expect("config/production.toml must load and validate with example secrets")
}

#[test]
fn production_config_loads_and_validates() {
    assert_eq!(production().event.name, "Nesting Box Back to School Photos 2026");
}

#[test]
fn production_listens_on_every_interface() {
    // The host's caddy edge dials 192.168.100.51:8080 across the veth; a
    // loopback bind would answer only inside the container.
    assert_eq!(production().server.bind, "0.0.0.0:8080");
}

#[test]
fn production_public_url_is_the_booking_host_over_https() {
    // admin.rs derives its CSRF origin check from this value, so a wrong
    // host here is a 403 on every mutating admin POST.
    assert_eq!(
        production().server.public_url,
        "https://booking.summerfieldphotography.com"
    );
}

#[test]
fn production_database_path_is_absolute() {
    // sqlx strips one "sqlite://" and treats the remainder as a path, so a
    // relative URL resolves against WorkingDirectory and lands in a
    // directory nothing creates.
    assert_eq!(
        production().server.database_url,
        "sqlite:///var/lib/photoform/booking.db?mode=rwc"
    );
}

#[test]
fn production_stays_in_paypal_sandbox() {
    assert_eq!(production().paypal.mode, "sandbox");
}

#[test]
fn production_carries_no_example_placeholders() {
    // config.example.toml ships "cid" and "sheet123"; either one reaching
    // production is a site that takes bookings and records none of them.
    let cfg = production();
    assert_ne!(cfg.paypal.client_id, "cid");
    assert_ne!(cfg.sheets.spreadsheet_id, "sheet123");
}
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /tmp/Sheet-Automation-FF && cargo test --test production_config
```

Expected: every test fails on the `expect`, reporting that `config/production.toml` could not be read.

- [ ] **Step 3: Write the config**

Create `/tmp/Sheet-Automation-FF/config/production.toml`. This is the working development config with exactly three lines changed — `bind`, `public_url`, `database_url`. The `<sandbox client ID>` and `<spreadsheet ID>` placeholders below stand in for the real values, which come from the repo owner's development config — this plan lives in the public nixcfg repo, so the real values belong only in the app repo:

```toml
# The deployed configuration, installed into the nix store by nixcfg's
# modules/photoform/package.nix and named through BOOKING_CONFIG.
#
# THIS FILE HOLDS NO SECRETS. The PayPal client secret, the SMTP password,
# the admin password, and the Google service-account JSON arrive as
# environment variables; the server refuses to start if any appears here.
# paypal.client_id is not one of them: it is rendered into every page as
# part of the PayPal SDK script URL.
#
# PayPal is in sandbox. Going live means editing this file, cutting a new
# rev, and redeploying — there is deliberately no runtime override.

[server]
bind = "0.0.0.0:8080"
public_url = "https://booking.summerfieldphotography.com"
database_url = "sqlite:///var/lib/photoform/booking.db?mode=rwc"

[business]
name = "Ari Summerfield Photography LLC"
contact_email = "AriSummerfieldPhotography@gmail.com"

[event]
name = "Nesting Box Back to School Photos 2026"
location = "The Nesting Box"
date = "September 12, 2026"
rain_date = "September 19, 2026"

[pricing]
price_cents = 4800
currency = "USD"
max_per_window = 4

[[windows]]
id = "w1"
label = "3:15-4:00pm"
starts_at = "15:15"
ends_at = "16:00"
capacity = 16
sawyer_url = "https://www.hisawyer.com/frenchie-farm/schedules/activity-set/1997113"

[[windows]]
id = "w2"
label = "4:15-5:00pm"
starts_at = "16:15"
ends_at = "17:00"
capacity = 16
sawyer_url = "https://www.hisawyer.com/frenchie-farm/schedules/activity-set/1997115"

[paypal]
mode = "sandbox"
client_id = "<sandbox client ID>"

[sheets]
spreadsheet_id = "<spreadsheet ID>"
sheet_name = "Bookings"

[smtp]
host = "smtp.gmail.com"
port = 587
username = "AriSummerfieldPhotography@gmail.com"
from = "Ari Summerfield Photography <AriSummerfieldPhotography@gmail.com>"
notify = "AriSummerfieldPhotography@gmail.com"

[admin]
username = "ari"
```

- [ ] **Step 4: Confirm the file is not gitignored**

`.gitignore` ignores `/config.toml` (repo root only) and `/data/`. `config/production.toml` matches neither, but check rather than assume — a silently ignored config is a build that installs nothing:

```bash
cd /tmp/Sheet-Automation-FF && git check-ignore -v config/production.toml; echo "exit=$?"
```

Expected: no output, `exit=1` (nothing matched).

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd /tmp/Sheet-Automation-FF && cargo test --test production_config
```

Expected: 6 passed.

- [ ] **Step 6: Run the whole suite**

The new file must not disturb anything else:

```bash
cd /tmp/Sheet-Automation-FF && cargo test
```

Expected: all tests pass.

- [ ] **Step 7: Commit and push**

```bash
cd /tmp/Sheet-Automation-FF
git add config/production.toml tests/production_config.rs
git commit -m "Add the deployed production config, checked by its own test"
git push origin main
```

- [ ] **Step 8: Record the rev**

```bash
cd /tmp/Sheet-Automation-FF && git rev-parse HEAD
```

Write it down. Task 2 pins this exact value.

---

## Task 2: Pin the new rev and install the config

**Files:**
- Modify: `modules/photoform/package.nix`
- Modify: `flake.nix` (the `packages` block, around line 87)

**Interfaces:**
- Consumes: Task 1's rev.
- Produces: `packages.x86_64-linux.photoform` with `passthru.cache = true`, whose output contains `share/photoform/production.toml`. Task 5's test asserts that path suffix; Task 3 substitutes this closure.

Both hashes are discovered locally. The nix-daemon here has no `NIX_GITHUB_PRIVATE_*` credentials and cannot be restarted, so the private fetch will not run — but neither hash needs it.

- [ ] **Step 1: Validate the offline source-hash method against a known-good value**

`feat/photoform-package` records `sha256-goPjgkUrh/fGjb//G4JJlV/FjgywGeenhDqv35nPU9k=` for rev `306b3a8`. Reproduce it before trusting the method on a rev nobody has verified:

```bash
rm -rf /tmp/pf-306b3a8 && mkdir -p /tmp/pf-306b3a8
cd /tmp/Sheet-Automation-FF
git archive --format=tar 306b3a8f25f2d48c2953af7879f2f63090c83a0d | tar -x -C /tmp/pf-306b3a8
nix hash path --sri --type sha256 /tmp/pf-306b3a8
```

Expected: `sha256-goPjgkUrh/fGjb//G4JJlV/FjgywGeenhDqv35nPU9k=`.

**If it does not match, stop and use the fallback:** commit `package.nix` with `sha256 = lib.fakeSha256;`, push the branch, and read the expected value out of the CI failure. Do not guess a hash.

- [ ] **Step 2: Compute the source hash for the new rev**

Substitute Task 1's rev for `<REV>`:

```bash
rm -rf /tmp/pf-new && mkdir -p /tmp/pf-new
cd /tmp/Sheet-Automation-FF
git archive --format=tar <REV> | tar -x -C /tmp/pf-new
nix hash path --sri --type sha256 /tmp/pf-new
```

Record the value.

- [ ] **Step 3: Compute the cargo hash**

`cargoHash` is a fixed-output hash of the vendor directory, determined by `Cargo.lock` alone — a local source produces the same value as the private fetch. In `modules/photoform/package.nix`, temporarily replace the whole `src = fetchFromGitHub { ... };` block with a path to the extracted tree:

```nix
  src = /tmp/pf-new;
```

Replace it rather than keeping the old attribute under a second name: any surviving reference to the `fetchFromGitHub` derivation makes it a build input, and building that here has no credential.

```bash
nix build --impure --no-link .#photoform 2>&1 | grep -A 3 'got:'
```

`--impure` because a flake in pure evaluation refuses an absolute path outside itself. Expected: a hash mismatch naming the `got:` value — that is `cargoHash`. Record it, then discard the edit:

```bash
git checkout modules/photoform/package.nix
```

- [ ] **Step 4: Write the package**

Replace `modules/photoform/package.nix` with the real values from Steps 2 and 3:

```nix
{
  rustPlatform,
  fetchFromGitHub,
  ...
}:
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "<REV>";
    sha256 = "<STEP 2 VALUE>";
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = "<STEP 3 VALUE>";
  # cargo installs the binary and nothing else; the module names this file
  # through BOOKING_CONFIG.
  postInstall = ''
    install -Dm444 config/production.toml $out/share/photoform/production.toml
  '';
  # Opt in to the binary cache: vps has 1 GB of RAM and cannot compile this.
  passthru.cache = true;
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
```

- [ ] **Step 5: Expose it as a flake package**

In `flake.nix`, in the `packages` block beside `encode_queue` and `caddy-l4`:

```nix
photoform = pkgs.callPackage ./modules/photoform/package.nix { };
```

`feat/photoform-package` adds this same line in this same place. If that branch is merged first, expect a conflict and keep both attributes.

- [ ] **Step 6: Prove evaluation needs no credential**

The whole point of `cargoHash` over `cargoLock.lockFile` is that evaluators never fetch the private source:

```bash
nix eval --raw .#packages.x86_64-linux.photoform.drvPath
nix eval .#packages.x86_64-linux.photoform.cache
```

Expected: a `.drv` path, then `true`. No network access, no credential error.

- [ ] **Step 7: Format and commit**

```bash
nix fmt
git add modules/photoform/package.nix flake.nix
git commit -m "feat(photoform): pin the app's shipped contract and install its config"
```

- [ ] **Step 8: Open the PR and let CI build it**

Push the branch and open a PR. CI gives nix-daemon `PRIVATE_SRC_PAT` and runs `nix flake check`, which builds `pkg-photoform`.

Expected: green. A `cargoHash` mismatch here means Step 3's value was wrong — take the `got:` value from the CI log and repeat from Step 4.

- [ ] **Step 9: Merge, and confirm the closure reached the cache**

Merge to `main`. On the push run, the "Push cached packages to the binary cache" step must list `photoform`:

```
caching: caddy-l4 encode_queue photoform
```

Then `verified` advances. **Do not proceed to Task 3 until this run is green.**

---

## Task 3: Prove vps substitutes the package

A gate, not a change. Nothing is committed here.

**Files:** none.

**Interfaces:**
- Consumes: Task 2's merged `verified` ref.
- Produces: the go/no-go for Tasks 5–8.

- [ ] **Step 1: Build the package on vps from the cache**

On vps:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  nix build --no-link --print-build-logs github:BJSummerfield/nixcfg/verified#photoform
```

Expected: `copying path '/nix/store/...-photoform-unstable' from 's3://spacefunk-nix-cache...'`, finishing in seconds.

**Any rustc output means stop.** vps has ~1 GB of RAM; a real compile there will thrash and fail, and it means the cache push did not cover this closure. Re-check Task 2 Step 9 before going further.

- [ ] **Step 2: Confirm the config rode along in the closure**

```bash
ls -l "$(nix path-info github:BJSummerfield/nixcfg/verified#photoform)/share/photoform/production.toml"
```

Expected: the file exists, mode `-r--r--r--`. If it is missing, `postInstall` did not run — fix Task 2 rather than working around it in the module.

---

## Task 4: Add the four secrets to sops

Hand work: it needs an age key, which only your workstation has. `.sops.yaml` already routes `secrets/hosts/vps.yaml` to `waktu_redtruck`, `waktu_t495` and `host_vps`, so no rule change is needed.

**Files:**
- Modify: `secrets/hosts/vps.yaml`

**Interfaces:**
- Produces: `photoform-paypal-client-secret`, `photoform-smtp-password`, `photoform-admin-password`, `photoform-sheets-sa`. Task 5's module declares exactly these four names.

- [ ] **Step 1: Gather the four values**

- `photoform-paypal-client-secret` — the **Sandbox** REST app's secret, paired with the client ID already in `config/production.toml`. A live secret against a sandbox client ID fails at capture, not at startup.
- `photoform-smtp-password` — the Gmail **app password** (16 characters) for `AriSummerfieldPhotography@gmail.com`, never the account password.
- `photoform-admin-password` — the HTTP Basic password for `/admin`, paired with username `ari`. The app rejects an empty value at startup precisely because an empty one would compare equal to an empty `Authorization` header.
- `photoform-sheets-sa` — the entire Google service-account JSON key, for an account with Editor access to the spreadsheet named by `<spreadsheet ID>`.

- [ ] **Step 2: Add them**

```bash
sops secrets/hosts/vps.yaml
```

Add four keys beside the existing ones. The service-account key is multi-line JSON, so it needs a block scalar:

```yaml
photoform-paypal-client-secret: <sandbox secret>
photoform-smtp-password: <gmail app password>
photoform-admin-password: <chosen password>
photoform-sheets-sa: |
  {
    "type": "service_account",
    "project_id": "...",
    "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    "client_email": "...@....iam.gserviceaccount.com",
    "token_uri": "https://oauth2.googleapis.com/token"
  }
```

- [ ] **Step 3: Verify all four decrypt, and that the JSON survived**

```bash
sops -d secrets/hosts/vps.yaml | grep -c '^photoform-'
sops -d --extract '["photoform-sheets-sa"]' secrets/hosts/vps.yaml | jq -e .client_email
```

Expected: `4`, then the service account's email. A `jq` parse error means the block scalar was mis-indented — fix it now, because the app reports this as a Sheets failure at runtime and keeps serving.

- [ ] **Step 4: Commit**

```bash
git add secrets/hosts/vps.yaml
git commit -m "feat(vps): photoform's four credentials"
```

---

## Task 5: Reconcile the module with the app's contract

The substance of this plan. Written test-first: the eval test encodes the contract, fails against today's module, and passes once the module matches.

**Files:**
- Create: `tests/photoform.nix`
- Modify: `flake.nix` (the `checks.x86_64-linux` block, beside `devboxes`, around line 115)
- Modify: `modules/photoform/nixos.nix`

**Interfaces:**
- Consumes: `packages.x86_64-linux.photoform` from Task 2; the four sops names from Task 4; `mine.system.caddy.routes` (`hostnames`/`mode`/`target`) and `mine.backups.paths`/`stopContainers`, both unchanged.
- Produces: `checks.x86_64-linux.photoform`, and a module ready for Task 6 to enable.

- [ ] **Step 1: Write the failing test**

Create `tests/photoform.nix`, modelled on `tests/devboxes.nix`:

```nix
# Pure-evaluation checks binding the photoform module to the app's shipped
# contract. Every value here is a name the app reads at startup, so a
# mismatch is a service that will not start — and the whole set is visible
# at eval time, which makes a VM test unnecessary.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  host =
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/backups/nixos.nix
        ../modules/caddy/nixos.nix
        ../modules/photoform/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine = {
            system = {
              hostName = "photoform-test";
              externalInterface = "eth0";
              caddy = {
                enable = true;
                acmeEmail = "test@example.com";
                fallback = "192.168.100.41:443";
              };
              photoform = {
                enable = true;
                sopsFile = ../secrets/hosts/vps.yaml;
              };
            };
            backups = {
              enable = true;
              repository = "s3:example/test";
              repoPasswordFile = "/dev/null";
              b2EnvFile = "/dev/null";
            };
          };
        }
      ];
    }).config;

  container = host.containers.photoform.config;
  unit = container.systemd.services.photoform;
  env = unit.environment;
  creds = unit.serviceConfig.LoadCredential;

  checks = [
    {
      # The app reads BOOKING_*, and reads the config path from
      # BOOKING_CONFIG. There is no --config flag.
      name = "every secret is named by its _FILE variable, pointing at a credential";
      ok =
        env.BOOKING_PAYPAL_CLIENT_SECRET_FILE
        == "/run/credentials/photoform.service/paypal-client-secret"
        && env.BOOKING_SMTP_PASSWORD_FILE == "/run/credentials/photoform.service/smtp-password"
        && env.BOOKING_ADMIN_PASSWORD_FILE == "/run/credentials/photoform.service/admin-password"
        && env.BOOKING_SHEETS_SERVICE_ACCOUNT_FILE == "/run/credentials/photoform.service/sheets-sa";
    }
    {
      # A plain BOOKING_X would put the value in /proc/<pid>/environ; the
      # app supports that form for local development only.
      name = "no secret value is carried in the environment itself";
      ok =
        !(env ? BOOKING_PAYPAL_CLIENT_SECRET)
        && !(env ? BOOKING_SMTP_PASSWORD)
        && !(env ? BOOKING_ADMIN_PASSWORD)
        && !(env ? BOOKING_SHEETS_SERVICE_ACCOUNT);
    }
    {
      name = "the config is named out of the package, not passed as a flag";
      ok =
        lib.hasSuffix "/share/photoform/production.toml" env.BOOKING_CONFIG
        && !(lib.hasInfix "--config" unit.serviceConfig.ExecStart);
    }
    {
      # LoadCredential is what makes a 0400 root-owned sops file readable by
      # the unprivileged in-container user; a bind mount alone would not.
      name = "all four secrets are loaded as credentials from their bind mounts";
      ok =
        lib.sort lib.lessThan creds == [
          "admin-password:/run/host-secrets/photoform-admin-password"
          "paypal-client-secret:/run/host-secrets/photoform-paypal-client-secret"
          "sheets-sa:/run/host-secrets/photoform-sheets-sa"
          "smtp-password:/run/host-secrets/photoform-smtp-password"
        ];
    }
    {
      name = "the host declares those four sops secrets and no others";
      ok =
        lib.sort lib.lessThan (lib.filter (lib.hasPrefix "photoform-") (lib.attrNames host.sops.secrets))
        == [
          "photoform-admin-password"
          "photoform-paypal-client-secret"
          "photoform-sheets-sa"
          "photoform-smtp-password"
        ];
    }
    {
      # The PayPal client ID is public and lives in the config file.
      name = "the PayPal client ID is not treated as a secret";
      ok =
        !(host.sops.secrets ? photoform-paypal-client-id) && !(host.sops.templates ? "photoform.env");
    }
    {
      name = "the edge routes the booking hostname to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.mode == "tls"
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
    {
      # restic reads the host side of the bind mount, with the container
      # stopped so the WAL-mode database is consistent.
      name = "the state directory is registered for backup with a container stop";
      ok =
        lib.elem "/var/lib/photoform-data" host.mine.backups.paths
        && lib.elem "photoform" host.mine.backups.stopContainers;
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "photoform-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
```

- [ ] **Step 2: Wire it into the flake checks**

In `flake.nix`, beside `devboxes` in the `checks.x86_64-linux` block:

```nix
photoform = import ./tests/photoform.nix {
  inherit nixpkgs inputs;
  system = "x86_64-linux";
};
```

- [ ] **Step 3: Run the check and watch it fail**

```bash
nix build --no-link .#checks.x86_64-linux.photoform
```

Expected: failure listing the contract mismatches, including the `BOOKING_*` variables, the `--config` flag, the four-vs-five secrets, and the hostname.

- [ ] **Step 4: Capture the blast-radius baseline**

```bash
for h in elitebook paynefield redtruck t495 vps; do
  printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
done
```

Save the output.

- [ ] **Step 5: Rewrite the module**

In `modules/photoform/nixos.nix`, make these changes and no others.

Replace the header comment's last sentence, since secrets no longer arrive as a rendered env file:

```nix
# PhotoForm booking webapp container, fronted publicly by the caddy edge.
# The package arrives only through the private binary cache — this host
# must never compile it. Each secret is a sops file bind-mounted in and
# loaded as a systemd credential, so no credential value ever enters the
# app's environment; the app's content lives in production.toml inside the
# package, so a new shoot is an app-repo commit plus a rev bump.
```

Narrow the `sopsFile` description to four secrets:

```nix
    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        sops file holding photoform-paypal-client-secret,
        photoform-smtp-password, photoform-admin-password and
        photoform-sheets-sa (the Google service-account JSON).
      '';
    };
```

Drop `photoform-paypal-client-id` from `sops.secrets`, leaving four:

```nix
    sops.secrets = {
      photoform-paypal-client-secret.sopsFile = cfg.sopsFile;
      photoform-smtp-password.sopsFile = cfg.sopsFile;
      photoform-admin-password.sopsFile = cfg.sopsFile;
      photoform-sheets-sa.sopsFile = cfg.sopsFile;
    };
```

Delete the entire `sops.templates."photoform.env"` block and its comment.

Change the caddy route hostname:

```nix
        hostnames = [ "booking.summerfieldphotography.com" ];
```

Replace the container's three `bindMounts` with four, one per secret:

```nix
      bindMounts = {
        "/var/lib/photoform" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };
        "/run/host-secrets/photoform-paypal-client-secret" = {
          hostPath = config.sops.secrets.photoform-paypal-client-secret.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-smtp-password" = {
          hostPath = config.sops.secrets.photoform-smtp-password.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-admin-password" = {
          hostPath = config.sops.secrets.photoform-admin-password.path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-sheets-sa" = {
          hostPath = config.sops.secrets.photoform-sheets-sa.path;
          isReadOnly = true;
        };
      };
```

Replace the unit's `ExecStart`, `EnvironmentFile` and single `LoadCredential` with the bare binary, an environment naming each credential, and four credentials:

```nix
          systemd.services.photoform = {
            description = "PhotoForm booking web service";
            wantedBy = [ "multi-user.target" ];
            after = [ "network.target" ];
            # _FILE forms only: the app also accepts the value directly, but
            # that would put four credentials in /proc/<pid>/environ.
            environment = {
              BOOKING_CONFIG = "${photoform}/share/photoform/production.toml";
              BOOKING_PAYPAL_CLIENT_SECRET_FILE = "/run/credentials/photoform.service/paypal-client-secret";
              BOOKING_SMTP_PASSWORD_FILE = "/run/credentials/photoform.service/smtp-password";
              BOOKING_ADMIN_PASSWORD_FILE = "/run/credentials/photoform.service/admin-password";
              BOOKING_SHEETS_SERVICE_ACCOUNT_FILE = "/run/credentials/photoform.service/sheets-sa";
            };
            serviceConfig = {
              User = "photoform";
              Group = "photoform";
              ExecStart = lib.getExe photoform;
              # Copied by root into a per-unit tmpfs owned by User, which is
              # what makes a 0400 root-owned sops file readable here. The
              # credentials path is literal: /run/credentials/<unit> is
              # stable systemd API.
              LoadCredential = [
                "paypal-client-secret:/run/host-secrets/photoform-paypal-client-secret"
                "smtp-password:/run/host-secrets/photoform-smtp-password"
                "admin-password:/run/host-secrets/photoform-admin-password"
                "sheets-sa:/run/host-secrets/photoform-sheets-sa"
              ];
              WorkingDirectory = "/var/lib/photoform";
              Restart = "on-failure";
              ProtectHome = true;
              PrivateTmp = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/photoform" ];
              ProtectControlGroups = true;
              ProtectKernelTunables = true;
              NoNewPrivileges = true;
              RestrictAddressFamilies = [
                "AF_UNIX"
                "AF_INET"
                "AF_INET6"
              ];
            };
          };
```

- [ ] **Step 6: Run the check and watch it pass**

```bash
nix fmt
nix build --no-link .#checks.x86_64-linux.photoform
```

Expected: success, no output.

- [ ] **Step 7: Prove the blast radius is zero**

The module is imported everywhere but enabled nowhere yet, so every host — vps included — must be byte-identical to Step 4's baseline:

```bash
for h in elitebook paynefield redtruck t495 vps; do
  printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
done
```

Expected: all five drvPaths unchanged. A change here means the module is no longer inert — find it before going further.

- [ ] **Step 8: Commit**

```bash
git add tests/photoform.nix flake.nix modules/photoform/nixos.nix
git commit -m "feat(photoform): match the app's shipped secrets and config contract"
```

---

## Task 6: Enable on vps and deploy

**Files:**
- Modify: `hosts/vps/default.nix`

**Interfaces:**
- Consumes: Task 3's substitution proof, Task 4's secrets, Task 5's module, and the DNS record.
- Produces: a live site.

- [ ] **Step 1: Capture the blast-radius baseline**

```bash
for h in elitebook paynefield redtruck t495 vps; do
  printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
done
```

- [ ] **Step 2: Enable the module**

In `hosts/vps/default.nix`, inside `mine.system`, after the `caddy` block:

```nix
      # Booking site behind the edge. The package is substituted, never
      # compiled: 1 GB of RAM cannot build it.
      photoform = {
        enable = true;
        sopsFile = ../../secrets/hosts/vps.yaml;
      };
```

- [ ] **Step 3: Check the flake**

`nix flake check` as a whole cannot pass here: it builds `pkg-photoform`, whose private fetch has no credential on this machine. Run the checks that matter and let CI run the full set:

```bash
nix fmt
nix build --no-link \
  .#checks.x86_64-linux.photoform \
  .#checks.x86_64-linux.devboxes \
  .#checks.x86_64-linux.nixos-vps \
  .#checks.x86_64-linux.caddyfile-vps
```

Expected: all four succeed. `caddyfile-vps` runs the real caddy binary's adapter over vps's rendered config, so it proves the new route is valid layer4 syntax; it may compile caddy-with-l4 locally if that closure is not already substitutable.

- [ ] **Step 4: Confirm only vps changed**

```bash
for h in elitebook paynefield redtruck t495 vps; do
  printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
done
```

Expected: vps's drvPath differs from Step 1; the other four are identical.

- [ ] **Step 5: Confirm the edge still fails open to mail**

The registry now holds a second route. Prove the fallback is untouched:

```bash
nix eval --json .#nixosConfigurations.vps.config.mine.system.caddy.routes
nix eval --raw .#nixosConfigurations.vps.config.mine.system.caddy.fallback
```

Expected: one route, `photoform`, claiming `booking.summerfieldphotography.com`; fallback still `192.168.100.41:443`.

- [ ] **Step 6: Commit, merge, deploy**

```bash
git add hosts/vps/default.nix
git commit -m "feat(vps): serve the booking site"
```

Push, open the PR, merge once CI is green and `verified` has advanced. Then on vps:

```bash
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified
```

Expected: paths are copied from the cache; nothing compiles.

- [ ] **Step 7: Watch the service start**

```bash
sudo nixos-container status photoform
sudo nixos-container run photoform -- systemctl status photoform
sudo nixos-container run photoform -- journalctl -u photoform -n 50
```

Expected: active, and a log line reporting `bind=0.0.0.0:8080 mode=sandbox listening`.

If instead the log names missing secrets, the app reports all of them in one error — check the credentials landed:

```bash
sudo nixos-container run photoform -- ls -l /run/credentials/photoform.service/
```

Expected: four files owned by `photoform`.

- [ ] **Step 8: Confirm the database landed where the config says**

```bash
sudo nixos-container run photoform -- ls -l /var/lib/photoform/
sudo ls -l /var/lib/photoform-data/
```

Expected: `booking.db` (plus `-wal` and `-shm`) visible from both sides of the bind mount. Anything under a `data/` subdirectory means the config's `database_url` lost its leading slash.

- [ ] **Step 9: Confirm the certificate**

```bash
echo | openssl s_client -connect booking.summerfieldphotography.com:443 \
  -servername booking.summerfieldphotography.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Expected: a subject naming the booking host, issued by Let's Encrypt. Stalwart's certificate here means the SNI route did not match — check the hostname in the rendered Caddyfile before touching DNS.

---

## Task 7: Verify the deployment end to end

No files change. This is the acceptance run, and it is the last chance to catch a sandbox/live PayPal mismatch before the URL is shared.

- [ ] **Step 1: The form loads**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://booking.summerfieldphotography.com/
```

Expected: `200`.

- [ ] **Step 2: Take a booking with a PayPal sandbox buyer**

In a browser: open the site, pick a window, complete checkout with a PayPal **sandbox** test buyer account.

Expected: the confirmation page renders.

- [ ] **Step 3: Confirm the booking reached the sheet and the mailbox**

Expected: a new row in the `<spreadsheet ID>` spreadsheet, and a confirmation email at `AriSummerfieldPhotography@gmail.com`.

If either is missing, the app degrades deliberately rather than failing — the booking is recorded and queued. Check which client is disabled:

```bash
sudo nixos-container run photoform -- journalctl -u photoform | grep -E 'Sheets disabled|email disabled'
```

- [ ] **Step 4: Confirm admin auth**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -u ari:wrong https://booking.summerfieldphotography.com/admin
curl -sS -o /dev/null -w '%{http_code}\n' -u ari:<sops password> https://booking.summerfieldphotography.com/admin
```

Expected: `401`, then `200`.

- [ ] **Step 5: Run the mail regression battery**

The edge now has a real route beside the fallback, so re-prove mail:

```bash
echo | openssl s_client -connect mx1.brianjs.com:443 -servername mx1.brianjs.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer
curl -sSf https://mx1.brianjs.com/.well-known/jmap -o /dev/null -w '%{http_code}\n'
```

Expected: Stalwart's own certificate, and an HTTP status from JMAP (`401` is fine — it answered through the fallback).

- [ ] Send and receive a real message from the mail client (IMAPS + SMTPS).
- [ ] An external sender (Gmail → a `brianjs.com` address) arrives.
- [ ] Webadmin loads at `https://stalwart.mist-gamma.ts.net:8443`.

---

## Task 8: Prove the backup captures the database

The registration merged with the module long ago and has never run against real data. `mine.backups` asserts only that some path was registered, never that anything exists there.

- [ ] **Step 1: Confirm the job knows about photoform**

```bash
nix eval --json .#nixosConfigurations.vps.config.mine.backups.paths
nix eval --json .#nixosConfigurations.vps.config.mine.backups.stopContainers
```

Expected: `/var/lib/photoform-data` among the paths, `photoform` among the stopped containers.

- [ ] **Step 2: Run the backup by hand**

On vps:

```bash
sudo systemctl start restic-backups-host.service
sudo systemctl status restic-backups-host.service
```

Expected: the unit succeeds. It stops the photoform container for the duration.

- [ ] **Step 3: Confirm the database is in the snapshot**

```bash
sudo restic-host snapshots | tail -5
sudo restic-host ls latest | grep booking.db
```

Expected: a snapshot from today listing `/var/lib/photoform-data/booking.db`. If the wrapper is not on PATH, the equivalent is `restic` with `-r`, `--password-file` and the B2 environment file from `hosts/vps/default.nix`.

- [ ] **Step 4: Confirm the container came back**

`backupCleanupCommand` restarts it with `|| true`, so a restart failure surfaces as the container's own failed unit rather than a failed backup:

```bash
sudo nixos-container status photoform
curl -sS -o /dev/null -w '%{http_code}\n' https://booking.summerfieldphotography.com/
```

Expected: `up`, then `200`.

- [ ] **Step 5: Record the milestone**

Append to `docs/superpowers/plans/2026-08-22-photoform-deployment.md` a short status section: the deployed rev, the date, and that PayPal is in sandbox pending a content-only redeploy to go live.

```bash
git add docs/superpowers/plans/2026-08-22-photoform-deployment.md
git commit -m "docs(photoform): record the sandbox deployment milestone"
```

---

## Follow-ups (deliberately not in this plan)

- **The missing-data-directory bug**, in the app repo: `db::connect` should `create_dir_all` the parent of the database file. `create_if_missing` maps to `SQLITE_OPEN_CREATE`, which creates the file but not its directory, so a fresh clone stalls for `SqlitePoolOptions`' 30-second acquire timeout and then fails with `SQLITE_CANTOPEN`. Development-only: production's state directory is created by the container's tmpfiles rule.
- **Going live on PayPal**: edit `config/production.toml` to `mode = "live"` with the live client ID, rotate `photoform-paypal-client-secret`, cut a rev, bump both hashes, redeploy. Deliberately a full redeploy — a runtime toggle belongs with per-site settings in a future admin console.
- **The app repo's README** calls nixcfg private; it is public.
