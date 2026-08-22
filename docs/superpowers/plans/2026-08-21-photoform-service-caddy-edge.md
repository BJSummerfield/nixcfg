# PhotoForm Service + Caddy Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicly serve the PhotoForm booking site on vps's 443 next to the live Stalwart mail server, via a generic SNI-routing Caddy edge module, with PhotoForm delivered exclusively through the private binary cache.

**Architecture:** Caddy's out-of-tree `layer4` app owns host 443 and routes by ClientHello SNI: registered web hostnames terminate in Caddy's own HTTPS server (automatic ACME over port 80 HTTP-01) and reverse-proxy to their service; every unmatched connection — unknown SNI, no SNI, non-TLS — passes through encrypted to Stalwart's container 443, reproducing today's DNAT exactly. The edge is a registry module (`mine.system.caddy`, same shape as `mine.backups`); the PhotoForm app runs in a new nspawn container and registers its route and its backup path, both guarded so registrations are inert elsewhere.

**Tech Stack:** NixOS (nixpkgs nixos-unstable pin), `pkgs.caddy.withPlugins` + `github.com/mholt/caddy-l4`, systemd-nspawn containers, sops-nix (`sops.templates` env rendering), restic backups, private B2 binary cache (`s3://spacefunk-nix-cache`).

**Spec:** `docs/superpowers/specs/2026-08-21-photoform-service-caddy-edge-design.md`

## Global Constraints

- **Ordering rule (spec):** the photoform container may not land on vps until vps demonstrably substitutes photoform from the cache — binary-cache plan Tasks 8–9 (`docs/superpowers/plans/2026-08-18-photoform-binary-cache.md`) must be green first. There is no state in which vps tries to compile the app. Tasks 7–10 below are gated on Task 2.
- **Fail-open toward mail:** vps's `fallback` is the Stalwart container's 443 (`192.168.100.41:443`). A registry mistake breaks the booking site, never mail.
- Env var names, verbatim: `PHOTOFORM_PAYPAL_CLIENT_ID`, `PHOTOFORM_PAYPAL_CLIENT_SECRET`, `PHOTOFORM_SMTP_PASSWORD`, `PHOTOFORM_ADMIN_PASSWORD`, `PHOTOFORM_SHEETS_CREDENTIALS_FILE`.
- Booking hostname: `booking.arisummerfieldphotography.com`. Container name `photoform` (must stay ≤ 11 chars for the `ve-` veth), hostAddress `192.168.100.50`, localAddress `192.168.100.51`, app port `8080`. Binary is `nesting-box-booking`; package/attr name is `photoform`.
- Cache store string: `s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005`. Anything vps must not compile carries `passthru.cache = true` so CI builds and pushes it.
- **Blast radius:** every task that touches shared modules ends by proving the other hosts' toplevel drvPaths are unchanged. Capture the "before" values at the start of the task with:
  ```bash
  for h in elitebook paynefield redtruck t495 vps; do
    printf '%s ' "$h"; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
  done
  ```
- Deploy flow for vps: merge to `main` → CI green → `verified` advances → on vps: `sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified`.
- Run `nix fmt` before committing any `.nix` change (formatter is nixfmt-tree). Comments state the reason in one sentence, lead with the conclusion, no history, no cross-references (`docs/superpowers/specs/2026-08-09-comment-style-design.md`).
- Mail sending stays Gmail (the app's SMTP is the business Gmail app password); nothing here touches Stalwart's mail config, DB, or ACME.
- Architecture B (Caddy as sole TLS authority) is designed-for, not built: it must remain a route-mode flip, so nothing in the edge module may assume every route terminates in Caddy.

---

## Status — 2026-08-22

Tasks 3, 4, 5 and 7 are done and merged on `spiffy-blobfish`. Task 6 is done through Step 3; **nothing has been deployed to vps yet** — Steps 4–7 (local build, deploy, mail regression battery, milestone) are open, and until the branch merges and `verified` advances there is no edge running anywhere.

Deviations from the plan as written, all deliberate:

- **`caddy-l4` is pinned at the tag `v0.1.2`, not a pseudo-version.** Task 3 Step 1 assumed the repo had no releases; it does now. `caddy list-modules` confirms the `layer4` app and its handlers are compiled in.
- **Task 7 landed ahead of its own gate.** The module is written and inert, but Task 1 has not run, so the contract it hardcodes (env var names, `$out/share/photoform/production.toml`, `--config`, `0.0.0.0:8080`) is still unverified against the app. Nothing deploys it until Task 8, so the risk is only rework.
- **`privateCache.enable = true` is now on vps** (commit `0561554`), ahead of Task 2, because Task 6 Step 5's deploy would otherwise compile caddy-with-l4 in 1 GB of RAM. The store path CI pushes and the one vps wants are the same derivation, verified by comparing `packages.x86_64-linux.caddy-l4.drvPath` against `nixosConfigurations.vps.config.services.caddy.package.drvPath`.
- **Task 6 Step 3 is now automated.** `checks.x86_64-linux.caddyfile-<host>` runs `caddy adapt` over every caddy-enabled host's rendered config, so the manual validation is a CI gate rather than a one-time step. The eval-only host checks never render a Caddyfile.
- **Binary-cache Task 8 is already half-done on the unmerged `feat/photoform-package` branch** — rev `306b3a8`, real `sha256`/`cargoHash`, `passthru.cache = true`, `photoform` in `packages`. That rev **predates Task 1**, so both hashes change once the app repo lands its secrets contract. That branch and this one both add a line to the same spot in flake.nix's `packages` block: expect a conflict, and keep both attrs.

## File Structure

| File | Responsibility |
|---|---|
| `modules/caddy/package.nix` | **Create.** Caddy + pinned `caddy-l4` plugin, `passthru.cache = true`. The only place the plugin pin lives. |
| `modules/caddy/nixos.nix` | **Create.** Generic `mine.system.caddy` edge: options, layer4 + vhost rendering, firewall. |
| `modules/photoform/nixos.nix` | **Create.** PhotoForm nspawn container, secrets template, caddy-route and backup registrations. |
| `modules/nixos.nix` | **Modify.** Import the two new modules. |
| `modules/stalwart-server/nixos.nix` | **Modify.** 443 DNAT + firewall entry become conditional on the caddy edge. |
| `flake.nix` | **Modify.** `caddy-l4` in `packages` so CI builds/caches it. |
| `hosts/vps/default.nix` | **Modify.** Enable caddy (Task 6), then photoform (Task 8). |
| `secrets/hosts/vps.yaml` | **Modify.** Five new `photoform-*` secrets. |
| `BJSummerfield/Sheet-Automation-FF` (separate private repo) | **Modify.** Task 1 prerequisites — the interface contract this plan builds against. |

---

## Task 1: Upstream app-repo prerequisites (Sheet-Automation-FF)

Hand work in the private app repo, done outside nixcfg. It defines the contract every later task assumes — do not start Task 7 until each box here is checked, because the NixOS module hardcodes these exact names and paths.

**Superseded by a step-by-step plan:** `docs/superpowers/plans/2026-08-22-photoform-app-secrets-contract.md`. That plan has the actual Rust, the tests, and the README section; the steps below are its summary and its acceptance criteria. Execute it, then tick these boxes.

**Interfaces:**
- Produces: an app commit (record its `rev` — Task 2 pins it) where:
  - The four secrets are read **only** from env: `PHOTOFORM_PAYPAL_CLIENT_ID`, `PHOTOFORM_PAYPAL_CLIENT_SECRET`, `PHOTOFORM_SMTP_PASSWORD`, `PHOTOFORM_ADMIN_PASSWORD`. The corresponding TOML fields are deleted, and a file that still carries one is a startup error, not a silent fallback.
  - `PHOTOFORM_SHEETS_CREDENTIALS_FILE` overrides `sheets.service_account_json_path`.
  - **`--config <path>` selects the config file.** The app as it stands reads only the `BOOKING_CONFIG` env var (`src/main.rs`), but `modules/photoform/nixos.nix` already ships `ExecStart = ... --config …/production.toml`. One of the two has to move; the app grows the flag, keeping `BOOKING_CONFIG` as the dev fallback.
  - `config/production.toml` is committed (real event content, zero secrets) and lands at `$out/share/photoform/production.toml`.
  - `production.toml` listens on `0.0.0.0:8080` and its sqlite database path is an absolute path under `/var/lib/photoform/` (the container's state dir).

- [ ] **Step 1: Move the four secrets to env, delete the TOML fields**

In the app repo, replace each `config.toml` secret read with the env var of the same meaning, and delete the fields from the TOML schema so a stray committed secret is a parse error, not a silent fallback.

- [ ] **Step 2: Make the service-account path env-overridable**

`PHOTOFORM_SHEETS_CREDENTIALS_FILE`, when set, wins over `sheets.service_account_json_path`.

- [ ] **Step 3: Commit `config/production.toml` and install it**

Real event/rain dates, the four-vs-five images contradiction in `contract.md` resolved (both flagged in the repo's own comments). Bind address `0.0.0.0:8080`; sqlite path under `/var/lib/photoform/`. Extend the build (build.rs / Makefile / cargo `include` — whatever the repo uses; a `postInstall` cp in nixcfg's `package.nix` is the fallback if upstream install is awkward) so the file lands at `$out/share/photoform/production.toml`.

- [ ] **Step 4: Verify locally**

```bash
PHOTOFORM_PAYPAL_CLIENT_ID=x PHOTOFORM_PAYPAL_CLIENT_SECRET=x \
PHOTOFORM_SMTP_PASSWORD=x PHOTOFORM_ADMIN_PASSWORD=x \
PHOTOFORM_SHEETS_CREDENTIALS_FILE=/tmp/fake-sa.json \
cargo run -- --config config/production.toml
```

Expected: the app starts and serves the form on `:8080` (Sheets/PayPal calls may fail with the fake values — startup and listen are what is being verified). Unset one env var and confirm the app refuses to start rather than falling back to a TOML value.

- [ ] **Step 5: Record the rev**

```bash
git rev-parse HEAD
```

Save it — Task 2 pins it in `modules/photoform/package.nix`.

---

## Task 2: Deliver photoform through the cache (binary-cache plan Tasks 8–9)

Not re-planned here — execute **Tasks 8 and 9 of `docs/superpowers/plans/2026-08-18-photoform-binary-cache.md`** exactly as written, using Task 1's `rev` when substituting the real source hash. That plan's steps cover the PAT, the two-hash discovery, `passthru.cache = true`, enabling `privateCache` on vps, and the substitution proof.

- [ ] **Step 1: Run binary-cache Task 8** — photoform into `packages` with the Task 1 rev, real `sha256` + `cargoHash` via CI, credential-free eval re-verified.
- [ ] **Step 2: Run binary-cache Task 9** — `privateCache.enable = true` on vps, then on vps:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  nix build --no-link --print-build-logs github:BJSummerfield/nixcfg/verified#photoform
```

Expected: `copying path '/nix/store/...-photoform-...' from 's3://spacefunk-nix-cache...'`. **This is the gate for Tasks 7–10.** Rust compilation output here means stop — do not proceed to the container.

Tasks 3–6 (the edge, fallback-only) do not depend on this task and may run in parallel with it.

---

## Task 3: Pinned caddy-l4 package, built and cached by CI

**Files:**
- Create: `modules/caddy/package.nix`
- Modify: `flake.nix`

**Interfaces:**
- Produces: `pkgs.callPackage ./modules/caddy/package.nix { }` — caddy with the layer4 app compiled in, `passthru.cache = true`; flake attr `caddy-l4` so CI builds it (`pkg-caddy-l4` check) and pushes it to the cache, keeping the Go compile off vps's 1 GB.

- [x] **Step 1: Discover the plugin pseudo-version**

`mholt/caddy-l4` has no tagged releases, so the pin is a Go pseudo-version:

```bash
nix shell nixpkgs#go -c go list -m github.com/mholt/caddy-l4@latest
```

Expected output shape: `github.com/mholt/caddy-l4 v0.0.0-20250xxxxxxxxx-xxxxxxxxxxxx`. Record the `v0.0.0-...` string.

- [x] **Step 2: Write the package with a fake hash**

Create `modules/caddy/package.nix`:

```nix
# Caddy with the out-of-tree layer4 app compiled in. caddy-l4 has no tagged
# releases, so the pin is a Go pseudo-version. A caddy bump in nixpkgs
# invalidates `hash`; CI catches that as a pkg-caddy-l4 build failure and
# hosts stay on their last good build.
{ caddy, lib }:
(caddy.withPlugins {
  plugins = [ "github.com/mholt/caddy-l4@v0.0.0-<value from Step 1>" ];
  hash = lib.fakeHash;
}).overrideAttrs
  (old: {
    # Opt in to the binary cache: vps must substitute its edge, never
    # compile it.
    passthru = (old.passthru or { }) // {
      cache = true;
    };
  })
```

- [x] **Step 3: Expose it in `flake.nix`**

In the `packages` block, alongside `encode_queue`:

```nix
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
          caddy-l4 = pkgs.callPackage ./modules/caddy/package.nix { };
```

- [x] **Step 4: Build locally to discover the real hash**

```bash
nix build --no-link .#caddy-l4 2>&1 | tail -5
```

Expected: `hash mismatch` with a `got: sha256-...` line. Replace `lib.fakeHash` with that value; `lib` stays (it is still an argument only if used — after the substitution drop `lib` from the argument set since nothing references it).

- [x] **Step 5: Build again and confirm the plugin is in**

```bash
nix build --no-link .#caddy-l4
nix run .#caddy-l4 -- list-modules | grep -c '^layer4'
```

Expected: the build succeeds and the count is ≥ 1 (the `layer4` app plus its handlers/matchers). `0` means the plugin string is wrong — recheck Step 1's pseudo-version.

- [x] **Step 6: Confirm host blast radius is zero**

`packages` entries never enter host closures by themselves:

```bash
nix flake check --print-build-logs 2>&1 | tail -3
```

plus the Global Constraints drvPath loop — all five unchanged from before this task.

- [x] **Step 7: Commit**

```bash
nix fmt
git add modules/caddy/package.nix flake.nix
git commit -m "feat(caddy): pin caddy-l4 into a cached package

CI builds it (pkg-caddy-l4) and pushes it to B2, so vps substitutes its
edge instead of running a Go compile in 1 GB of RAM."
```

---

## Task 4: The `mine.system.caddy` edge module

**Files:**
- Create: `modules/caddy/nixos.nix`
- Modify: `modules/nixos.nix`

**Interfaces:**
- Consumes: `modules/caddy/package.nix` (Task 3).
- Produces: options `mine.system.caddy.{enable, acmeEmail, fallback, routes}`; `routes` is `attrsOf { hostnames : listOf str; mode : "tls" | "tcp"; target : str }`. Service modules register into `routes` guarded on `config.mine.system.caddy.enable` (Task 7 consumes this). The stalwart module reads `config.mine.system.caddy.enable` (Task 5).

- [x] **Step 1: Write the module**

Create `modules/caddy/nixos.nix`:

```nix
# Generic SNI edge: a layer4 listener owns host 443 and routes by
# ClientHello SNI — "tls" routes hand off to Caddy's own HTTPS server
# (automatic ACME, reverse_proxy), "tcp" routes and the fallback are raw
# byte proxies. Every connection no route claims (unknown SNI, no SNI,
# non-TLS) degrades to the fallback, so a registry mistake breaks the
# routed site, never the fallback service. Port 80 is Caddy's own HTTP-01
# lane. Architecture B (Caddy as sole TLS authority) is a route flipping
# from "tcp" to "tls", not a rewrite.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
  # Where the HTTP app terminates TLS for layer4-matched hostnames. Only
  # the layer4 proxy dials it; the firewall never opens it.
  httpsPort = 8443;
  routeBlock = name: r: ''
    @${name} tls sni ${lib.concatStringsSep " " r.hostnames}
    route @${name} {
      proxy ${if r.mode == "tls" then "127.0.0.1:${toString httpsPort}" else r.target}
    }
  '';
  # The fallback renders last: layer4 tries routes in order and a route
  # with no matcher matches everything.
  layer4Server =
    lib.concatStrings (lib.mapAttrsToList routeBlock cfg.routes)
    + lib.optionalString (cfg.fallback != null) ''
      route {
        proxy ${cfg.fallback}
      }
    '';
  tlsRoutes = lib.filterAttrs (_: r: r.mode == "tls") cfg.routes;
in
{
  options.mine.system.caddy = {
    enable = lib.mkEnableOption "SNI-routing Caddy edge owning host ports 80 and 443";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      description = "ACME account contact for certificates Caddy obtains.";
    };

    fallback = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "192.168.100.41:443";
      description = ''
        host:port receiving every connection no route claims, as raw
        bytes. null closes unclaimed connections instead.
      '';
    };

    routes = lib.mkOption {
      default = { };
      description = ''
        SNI routing registry. Service modules register here guarded on
        this module's enable, so registrations are inert on hosts
        without an edge.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            hostnames = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "SNI names this route claims.";
            };
            mode = lib.mkOption {
              type = lib.types.enum [
                "tls"
                "tcp"
              ];
              description = ''
                tls: Caddy terminates (automatic ACME) and reverse-proxies
                plain HTTP to target. tcp: encrypted passthrough to target.
              '';
            };
            target = lib.mkOption {
              type = lib.types.str;
              example = "192.168.100.51:8080";
              description = "host:port behind this route.";
            };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.allUnique (lib.concatMap (r: r.hostnames) (lib.attrValues cfg.routes));
        message = "mine.system.caddy: a hostname is claimed by more than one route";
      }
    ];

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

    services.caddy = {
      enable = true;
      # The l4 plugin pin lives in ./package.nix, cached by CI.
      package = pkgs.callPackage ./package.nix { };
      email = cfg.acmeEmail;
      globalConfig = ''
        http_port 80
        https_port ${toString httpsPort}
        layer4 {
          :443 {
            ${layer4Server}
          }
        }
      '';
      # One vhost per hostname of every terminating route; Caddy obtains
      # and renews their certificates automatically.
      virtualHosts = lib.mkMerge (
        lib.mapAttrsToList (
          _: r:
          lib.genAttrs r.hostnames (_: {
            extraConfig = "reverse_proxy ${r.target}";
          })
        ) tlsRoutes
      );
    };
  };
}
```

- [x] **Step 2: Import it**

In `modules/nixos.nix`, after `./backups/nixos.nix`:

```nix
    ./caddy/nixos.nix
```

- [x] **Step 3: Verify the module is inert everywhere**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
```

plus the drvPath loop — **all five hosts unchanged** (nothing enables the module yet). A changed drvPath means something in the module leaks outside `mkIf cfg.enable`.

- [x] **Step 4: Commit**

```bash
git add modules/caddy/nixos.nix modules/nixos.nix
git commit -m "feat(caddy): generic SNI-routing edge module

Registry-shaped like mine.backups: services register hostname-list
routes guarded on the host's enable; unclaimed SNI falls through to the
fallback so mistakes break toward the routed site, never the fallback."
```

---

## Task 5: Stalwart's 443 forward becomes conditional

**Files:**
- Modify: `modules/stalwart-server/nixos.nix:55-88`

**Interfaces:**
- Consumes: `config.mine.system.caddy.enable` (Task 4).
- Produces: on caddy hosts, host 443 is free for Caddy's socket; mail-port forwards (25/465/993) unconditional; identical behaviour on non-caddy hosts.

- [x] **Step 1: Make the 443 firewall entry and DNAT conditional**

Replace the `networking.firewall.allowedTCPPorts` list and the `forwardPorts` list:

```nix
    networking.firewall.allowedTCPPorts = [
      25
      465
      993
    ]
    ++ lib.optional (!config.mine.system.caddy.enable) 443;
```

```nix
      # When the caddy edge owns host 443, its layer4 fallback replaces
      # this DNAT byte-for-byte; the mail-port forwards stay unconditional.
      forwardPorts = [
        {
          sourcePort = 25;
          destination = "192.168.100.41:25";
          proto = "tcp";
        }
        {
          sourcePort = 465;
          destination = "192.168.100.41:465";
          proto = "tcp";
        }
        {
          sourcePort = 993;
          destination = "192.168.100.41:993";
          proto = "tcp";
        }
      ]
      ++ lib.optionals (!config.mine.system.caddy.enable) [
        {
          sourcePort = 443;
          destination = "192.168.100.41:443";
          proto = "tcp";
        }
      ];
```

The container's own config (its internal 443 listener, its firewall) does not change — Stalwart keeps terminating TLS and running its own ACME.

- [x] **Step 2: Verify nothing changed anywhere**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
```

plus the drvPath loop — **all five unchanged**, vps included: caddy is still disabled, so both conditionals evaluate to today's exact lists.

- [x] **Step 3: Commit**

```bash
git add modules/stalwart-server/nixos.nix
git commit -m "feat(stalwart): yield host 443 to the caddy edge when present

The layer4 fallback reproduces the DNAT exactly; 25/465/993 forwards
stay unconditional."
```

---

## Task 6: Rollout step 1 — caddy on vps, fallback only, mail verified

This step deliberately stands alone: Caddy in front of Stalwart's web 443 is the one genuinely new risk (a userspace daemon where only a kernel NAT rule sat), so it deploys with **no routes** and gets a full mail regression pass before any web service is added.

**Files:**
- Modify: `hosts/vps/default.nix`

**Interfaces:**
- Consumes: `mine.system.caddy` options (Task 4), the conditional stalwart forward (Task 5), the cached `caddy-l4` (Task 3, must be merged so CI has pushed it).
- Produces: a live edge on vps whose only behaviour is today's behaviour.

- [x] **Step 1: Enable with only the fallback**

In `hosts/vps/default.nix`, inside `mine.system`, after `stalwart-server`:

```nix
      # SNI edge on 443. Fallback-only until photoform lands: every
      # connection behaves exactly like the old DNAT into Stalwart.
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
        fallback = "192.168.100.41:443";
      };
```

- [x] **Step 2: Confirm the blast radius is vps alone**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
```

drvPath loop: only vps's drvPath changed.

- [x] **Step 3: Validate the rendered Caddyfile with the real binary**

The layer4 Caddyfile syntax is the risky part — prove the plugin parses it before deploying:

```bash
# Nix 2.34.x cannot build a flake attribute whose value is a subpath
# string with context ("${drv}/Caddyfile"): extract the drv from that
# error and materialize the output root. On a newer Nix where the first
# command succeeds, the file is already materialized and the ^out line
# is skipped.
drv=$(nix build --print-out-paths .#nixosConfigurations.vps.config.services.caddy.configFile 2>&1 | grep -o '/nix/store/[a-z0-9]*-Caddyfile-formatted\.drv' || true)
[ -n "$drv" ] && nix build --no-link --print-out-paths "$drv^out"
caddyfile=$(nix eval --raw .#nixosConfigurations.vps.config.services.caddy.configFile)
nix run .#caddy-l4 -- adapt --config "$caddyfile" --adapter caddyfile | nix run nixpkgs#jq -- '.apps | keys'
```

Expected: a JSON key list containing `"layer4"`. An `unrecognized global option 'layer4'` error means the plugin is not in the binary — recheck Task 3 Step 5. Any other adapt error is a rendering bug in `modules/caddy/nixos.nix`.

- [ ] **Step 4: Build the whole system locally**

```bash
nix build --no-link .#nixosConfigurations.vps.config.system.build.toplevel
```

Expected: succeeds (caddy-l4 comes from the local store or the cache).

- [ ] **Step 5: Commit and deploy**

```bash
git add hosts/vps/default.nix
git commit -m "feat(vps): caddy edge live, fallback-only

Rollout step 1 stands alone: the edge in front of a live mail server is
the real new risk, so it ships with zero routes and gets a full mail
regression pass before any web service is added."
```

Merge to `main`, wait for `verified` to advance, then on vps:

```bash
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified
```

Watch the log: `caddy` should arrive via `copying path ... from 's3://spacefunk-nix-cache...'`, not a Go compile.

- [ ] **Step 6: Verify every mail path through the passthrough**

From a machine outside vps (`VPS` = its public IP or DNS name):

```bash
# Known mail SNI → Stalwart's own certificate, byte-for-byte passthrough
openssl s_client -connect $VPS:443 -servername mx1.brianjs.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
# Unclaimed SNI (pre-DNS booking probe) → also Stalwart's certificate
openssl s_client -connect $VPS:443 -servername booking.arisummerfieldphotography.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
# SNI-less legacy client → still Stalwart
openssl s_client -connect $VPS:443 -noservername </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
# Mail ports (untouched DNAT, but verify)
openssl s_client -connect $VPS:465 -quiet </dev/null 2>&1 | head -1     # Stalwart SMTP banner
openssl s_client -connect $VPS:993 -quiet </dev/null 2>&1 | head -1     # * OK IMAP
openssl s_client -connect $VPS:25 -starttls smtp </dev/null 2>/dev/null | openssl x509 -noout -subject
```

Expected: all three 443 probes show Stalwart's cert (subject `mx1.brianjs.com`); 25/465/993 answer as before. Then:

- [ ] Send and receive a real message from the mail client (IMAPS + SMTPS in use).
- [ ] Inbound from an external sender (e.g. Gmail → brianjs.com address) arrives.
- [ ] Webadmin loads at `https://stalwart.mist-gamma.ts.net:8443` (tailscale path, should be untouched).
- [ ] JMAP/web endpoints respond: `curl -sSf https://mx1.brianjs.com/.well-known/jmap -o /dev/null -w '%{http_code}\n'` returns an HTTP status (401 is fine — it answered through the fallback).
- [ ] Stalwart's ACME still has a lane: `sudo nixos-container run stalwart -- journalctl --since -1h | grep -i -E 'acme|tls' | tail`, no new errors. (Renewal itself flows through the fallback exactly like any TLS client; a forced check can wait for the next natural renewal window — note the current cert's notAfter from the first probe and re-probe after that date.)
- [ ] **Client IPs on 443 are now the host, not the internet.** DNAT rewrote only the destination, so Stalwart saw real client addresses; a userspace layer4 proxy does not, and every connection through the fallback now arrives from `192.168.100.40`. Ports 25/465/993 are untouched — this is web/JMAP/webadmin only. Check the webadmin's ban/rate-limit settings before leaving this running: a brute-force sweep against public 443 that trips a per-IP auto-ban will ban the host address and take out *all* web access through the edge at once. If that risk is unacceptable, the `layer4.handlers.proxy_protocol` handler is compiled into the pinned binary and Stalwart's listener would have to be taught to trust it — which is DB-managed config on a live mail server, so architecture A's default is to accept the change and watch for it.

**Any mail failure here: `git revert` the Task 6 commit, redeploy, then diagnose.** The revert restores the DNAT (Task 5's conditionals flip back).

- [ ] **Step 7: Record the milestone**

```bash
git commit --allow-empty -m "chore(caddy): edge verified transparent for mail on vps"
git push
```

---

## Task 7: The photoform module — container, secrets, registrations

**Gate: Task 2 green** (vps substitutes photoform) and Task 1 complete (the module hardcodes its contract). The module is written and merged inert here; Task 8 enables it.

**Files:**
- Create: `modules/photoform/nixos.nix`
- Modify: `modules/nixos.nix`

**Interfaces:**
- Consumes: `modules/photoform/package.nix` (pinned by Task 2); `mine.system.caddy.routes` (Task 4); `mine.backups.{paths,stopContainers}`.
- Produces: `mine.system.photoform.{enable, sopsFile}`. Expects `sopsFile` to contain keys `photoform-paypal-client-id`, `photoform-paypal-client-secret`, `photoform-smtp-password`, `photoform-admin-password`, `photoform-sheets-sa` (Task 8 creates them).

- [x] **Step 1: Write the module**

Create `modules/photoform/nixos.nix`:

```nix
# PhotoForm booking webapp container, fronted publicly by the caddy edge.
# The package arrives only through the private binary cache — this host
# must never compile it. Secrets are env vars rendered host-side by sops
# and bind-mounted in; the app's content lives in production.toml inside
# the package, so a new shoot is an app-repo commit plus a rev bump.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.photoform;
  hostStateDir = "/var/lib/photoform-data";
  photoform = pkgs.callPackage ./package.nix { };
in
{
  options.mine.system.photoform = {
    enable = lib.mkEnableOption "PhotoForm booking webapp container";

    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        sops file holding photoform-paypal-client-id,
        photoform-paypal-client-secret, photoform-smtp-password,
        photoform-admin-password and photoform-sheets-sa (the Google
        service-account JSON).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = {
      photoform-paypal-client-id.sopsFile = cfg.sopsFile;
      photoform-paypal-client-secret.sopsFile = cfg.sopsFile;
      photoform-smtp-password.sopsFile = cfg.sopsFile;
      photoform-admin-password.sopsFile = cfg.sopsFile;
      photoform-sheets-sa.sopsFile = cfg.sopsFile;
    };

    # Rendered on the host so the container never holds an age key. The
    # credentials path is literal: /run/credentials/<unit> is stable
    # systemd API, filled by LoadCredential below.
    sops.templates."photoform.env".content = ''
      PHOTOFORM_PAYPAL_CLIENT_ID=${config.sops.placeholder."photoform-paypal-client-id"}
      PHOTOFORM_PAYPAL_CLIENT_SECRET=${config.sops.placeholder."photoform-paypal-client-secret"}
      PHOTOFORM_SMTP_PASSWORD=${config.sops.placeholder."photoform-smtp-password"}
      PHOTOFORM_ADMIN_PASSWORD=${config.sops.placeholder."photoform-admin-password"}
      PHOTOFORM_SHEETS_CREDENTIALS_FILE=/run/credentials/photoform.service/sheets-sa
    '';

    # Outbound only (PayPal, Gmail SMTP, Google Sheets); inbound arrives
    # via the caddy edge on this host, never the external interface.
    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-photoform" ];
      externalInterface = config.mine.system.externalInterface;
    };

    system.activationScripts.photoform-dirs = ''
      mkdir -p ${hostStateDir}
      chmod 700 ${hostStateDir}
    '';

    mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
      routes.photoform = {
        hostnames = [ "booking.arisummerfieldphotography.com" ];
        mode = "tls";
        target = "192.168.100.51:8080";
      };
    };

    # Stop-strategy: the brief nightly stop closes sqlite cleanly before
    # restic reads the host-side state dir.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ hostStateDir ];
      stopContainers = [ "photoform" ];
    };

    containers.photoform = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.50";
      localAddress = "192.168.100.51";

      bindMounts = {
        "/var/lib/photoform" = {
          hostPath = hostStateDir;
          isReadOnly = false;
        };
        "/run/host-secrets/photoform.env" = {
          hostPath = config.sops.templates."photoform.env".path;
          isReadOnly = true;
        };
        "/run/host-secrets/photoform-sheets-sa" = {
          hostPath = config.sops.secrets.photoform-sheets-sa.path;
          isReadOnly = true;
        };
      };

      config =
        { lib, ... }:
        {
          users.users.photoform = {
            isSystemUser = true;
            group = "photoform";
            home = "/var/lib/photoform";
          };
          users.groups.photoform = { };

          # Re-owns the bind mount to the container's photoform uid on start.
          systemd.tmpfiles.rules = [
            "d /var/lib/photoform 0700 photoform photoform -"
          ];

          systemd.services.photoform = {
            description = "PhotoForm booking web service";
            wantedBy = [ "multi-user.target" ];
            after = [ "network.target" ];
            serviceConfig = {
              User = "photoform";
              Group = "photoform";
              ExecStart = "${lib.getExe photoform} --config ${photoform}/share/photoform/production.toml";
              # The env file is read by the manager and the credential by
              # root, so 0400-root host files work unchanged in here.
              EnvironmentFile = "/run/host-secrets/photoform.env";
              LoadCredential = [ "sheets-sa:/run/host-secrets/photoform-sheets-sa" ];
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

          networking = {
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              # Only the host's caddy dials in, over ve-photoform.
              allowedTCPPorts = [ 8080 ];
            };
          };

          system.stateVersion = "24.11";
        };
    };
  };
}
```

- [x] **Step 2: Import it**

In `modules/nixos.nix`, after `./pipewire/nixos.nix`:

```nix
    ./photoform/nixos.nix
```

- [x] **Step 3: Verify the module is inert**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
```

drvPath loop: **all five unchanged** — nothing enables photoform yet, and crucially photoform is not yet in vps's closure.

- [x] **Step 4: Commit**

```bash
git add modules/photoform/nixos.nix modules/nixos.nix
git commit -m "feat(photoform): booking webapp container module

Cache-fed package, env-rendered secrets, caddy route and backup
registrations both guarded so the module is inert without an edge or
backups host."
```

---

## Task 8: Enable photoform on vps — secrets, deploy, substitution proof

**Files:**
- Modify: `secrets/hosts/vps.yaml`
- Modify: `hosts/vps/default.nix`

**Interfaces:**
- Consumes: `mine.system.photoform` (Task 7); the live edge (Task 6); the cached package (Task 2).
- Produces: the container running on vps, reachable at `192.168.100.51:8080` from the host; the booking route registered in caddy (cert issuance waits on DNS, Task 9).

- [ ] **Step 1: Add the five secrets**

```bash
nix shell nixpkgs#sops -c sops secrets/hosts/vps.yaml
```

Add (values from the business's PayPal REST app, Gmail app password, chosen admin password, and the Google Cloud service-account key JSON):

```yaml
photoform-paypal-client-id: <client id>
photoform-paypal-client-secret: <client secret>
photoform-smtp-password: <gmail app password>
photoform-admin-password: <admin password>
photoform-sheets-sa: |
  {
    "type": "service_account",
    ...entire JSON key file...
  }
```

`secrets/hosts/vps.yaml` already matches a `.sops.yaml` rule encrypted to `host_vps` — no rule change needed.

- [ ] **Step 2: Enable on vps**

In `hosts/vps/default.nix`, inside `mine.system`, after the `caddy` block:

```nix
      photoform = {
        enable = true;
        sopsFile = ../../secrets/hosts/vps.yaml;
      };
```

- [ ] **Step 3: Verify locally before merging**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
```

drvPath loop: only vps changed. Then confirm the route landed in the rendered Caddyfile:

```bash
# Same Nix 2.34.x quirk as Task 6 Step 3: materialize the Caddyfile drv by name first.
drv=$(nix build --print-out-paths .#nixosConfigurations.vps.config.services.caddy.configFile 2>&1 | grep -o '/nix/store/[a-z0-9]*-Caddyfile-formatted\.drv' || true)
[ -n "$drv" ] && nix build --no-link --print-out-paths "$drv^out"
caddyfile=$(nix eval --raw .#nixosConfigurations.vps.config.services.caddy.configFile)
grep -A2 '@photoform' "$caddyfile" && grep -A1 'booking.arisummerfieldphotography.com' "$caddyfile"
```

Expected: an `@photoform tls sni booking.arisummerfieldphotography.com` matcher proxying `127.0.0.1:8443`, and a `booking.arisummerfieldphotography.com` vhost with `reverse_proxy 192.168.100.51:8080`.

- [ ] **Step 4: Commit and deploy**

```bash
git add secrets/hosts/vps.yaml hosts/vps/default.nix
git commit -m "feat(vps): photoform container + booking route + secrets

Rollout step 2a: container up behind the edge; DNS and the certificate
are the next step. Gated on the cache substitution proof."
```

Merge, wait for `verified`, then on vps:

```bash
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified 2>&1 | tee /tmp/rebuild.log
grep -E 'photoform' /tmp/rebuild.log | grep -E 'copying path|building'
```

Expected: `copying path '/nix/store/...-photoform-...' from 's3://spacefunk-nix-cache...'` and **no** `building` line for photoform. A build starting here is the OOM risk the whole design avoids — interrupt it and stop.

- [ ] **Step 5: Verify the container serves the form locally**

On vps:

```bash
sudo nixos-container status photoform                      # up
sudo nixos-container run photoform -- systemctl is-active photoform   # active
curl -sSf http://192.168.100.51:8080/ | head -20           # form HTML
```

If the service is failing, read `sudo nixos-container run photoform -- journalctl -u photoform -n 50` — a missing-env-var refusal means a secret name mismatch between the template and the app (Task 1's contract); a config parse error means production.toml drifted.

- [ ] **Step 6: Confirm the fallback still holds for mail**

Re-run the three 443 openssl probes from Task 6 Step 6. `mx1.brianjs.com` and `-noservername` still show Stalwart's cert. The booking SNI now reaches Caddy, which has no cert yet (issuance needs DNS) — a handshake failure or a self-signed placeholder there is expected and fine; **mail probes are the ones that must pass.**

---

## Task 9: Rollout step 2b — DNS, certificate, public probes

- [ ] **Step 1: Point DNS at vps**

At the DNS provider for `arisummerfieldphotography.com`, add an A record: `booking` → vps's public IPv4. Confirm propagation:

```bash
dig +short booking.arisummerfieldphotography.com
```

Expected: vps's IP.

- [ ] **Step 2: Watch Caddy obtain the certificate**

`services.caddy.logLevel` defaults to `ERROR`, and the whole obtain flow logs at INFO — so a successful issuance is *silent* and only failures show up in the journal. Watch the storage instead, and read the journal for the failure case:

```bash
# On vps. Appears within a minute or two of the DNS record resolving.
sudo watch -n5 'ls -R /var/lib/caddy/.local/share/caddy/certificates/'
sudo journalctl -u caddy -f
```

Expected: a directory under `certificates/acme-v02.api.letsencrypt.org-directory/` holding `booking.arisummerfieldphotography.com.crt` and `.key`, and a quiet journal. Repeated challenge failures do log at ERROR: check the A record and that port 80 is reachable (`curl -v http://booking.arisummerfieldphotography.com/`). To watch the flow live instead, set `services.caddy.logLevel = "INFO"` temporarily — it is not worth keeping.

- [ ] **Step 3: Public probes**

From outside vps:

```bash
openssl s_client -connect booking.arisummerfieldphotography.com:443 \
  -servername booking.arisummerfieldphotography.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer
curl -sSf https://booking.arisummerfieldphotography.com/ | head -20
openssl s_client -connect booking.arisummerfieldphotography.com:443 -servername mx1.brianjs.com </dev/null 2>/dev/null | openssl x509 -noout -subject
```

Expected: a Let's Encrypt-issued cert with subject `booking.arisummerfieldphotography.com`; the booking form's HTML; and the mx1 SNI probe still returning Stalwart's cert through the same IP and port.

- [ ] **Step 4: Record the milestone**

```bash
git commit --allow-empty -m "chore(photoform): booking site live with a Caddy-issued certificate"
git push
```

---

## Task 10: Rollout step 3 — end-to-end booking and backup proof

- [ ] **Step 1: Full test booking**

Complete the form at `https://booking.arisummerfieldphotography.com` end to end: form → PayPal (use the PayPal sandbox flow if production.toml is pointed at sandbox; if live, a minimal real transaction that gets refunded) → verify a new row appears in the Google Sheet → verify the confirmation/contract email arrives (sent via Gmail). If sandbox credentials were used for the test, swapping to live is a nixcfg-only change: `sops secrets/hosts/vps.yaml` **and** `mine.system.photoform.paypalMode = "live"`, then redeploy — no app commit. The mode has to move with the credentials or live keys end up pointed at the sandbox API; that option and its `PHOTOFORM_PAYPAL_MODE` env var come from `docs/superpowers/plans/2026-08-22-photoform-app-secrets-contract.md` Tasks 4 and 7.

- [ ] **Step 2: Verify the booking persisted**

On vps:

```bash
sudo ls -la /var/lib/photoform-data/
```

Expected: the sqlite database file, recently modified.

- [ ] **Step 3: Verify the backup covers it**

After the next nightly run (05:15 host schedule; the container is stopped for the copy and restarted — expect a brief form outage then):

```bash
sudo systemctl status restic-backups-host | head -5
sudo -E restic-host snapshots --latest 1 --path /var/lib/photoform-data 2>/dev/null \
  || sudo journalctl -u restic-backups-host --since -1d | grep -E 'photoform|Files:'
```

Expected: the latest snapshot includes `/var/lib/photoform-data`, and the journal shows the photoform container stop/start bracket around the run.

- [ ] **Step 4: Close out against the spec's success criteria**

- [ ] Booking site live with a valid certificate; a full test booking completed.
- [ ] Every mail protocol verified identical to pre-caddy (Task 6 Step 6 battery, re-run once more now).
- [ ] vps never compiled photoform (Task 8 Step 4 log is the evidence).
- [ ] Adding a future web service is one route attrset + one `caddy.enable` (true by construction — Tasks 4/7).
- [ ] Architecture B remains a route-mode flip (the `tcp`/`tls` enum exists and the fallback is orthogonal).

```bash
git commit --allow-empty -m "chore(photoform): sub-project B verified end to end

Booking site live behind the SNI edge, mail byte-identical, closure
cache-fed, backups covering the sqlite state."
git push
```

---

## Follow-ups deliberately not in this plan

- **Architecture B** — flipping Stalwart's web to a `tls`-mode route and sharing mail-port certs Caddy→container. Documented in the spec as a future flip; touching a live mail server's DB-managed certs needs its own spec.
- **The apex/main site and arisummerfield mail domains** — the apex joins photoform's `hostnames` list when the repo grows into the main site; mail hostnames become a `tcp` route to Stalwart.
- **Routes for immich/vikunja/jellyfin** — the module supports them; nobody wires them yet.
- **Client IPs** — the layer4 → HTTPS handoff means the HTTP app sees `127.0.0.1` as the peer; the booking form doesn't need real client IPs. If a future service does, add PROXY protocol to that route's handoff.
- **Per-event cadence** — every content change is an app-repo commit + `rev`/`sha256` bump + full CI build. Right at a few shoots a year; revisit if cadence grows.
