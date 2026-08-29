# Stock Caddy Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom caddy-l4 edge build with stock nixpkgs Caddy so every 443 route is a TLS route, delete the raw-byte fallback, and make the mail domain an ordinary caddy-terminated route.

**Architecture:** The `mine.system.caddy` module stops compiling the layer4 plugin and instead renders one Caddy vhost per claimed hostname (stock caddy is the sole TLS authority, automatic ACME over the port-80 HTTP-01 lane). Routes gain an optional `extraConfig` for the upstream transport; the VPS registers a `mail` route that reverse-proxies `https://192.168.100.41:443` (Stalwart's public listener) with a TLS-insecure upstream. The custom build, its vendor hash, and the 8443 handoff disappear; caddy substitutes from `cache.nixos.org`.

**Tech Stack:** NixOS configuration (flake), nixpkgs at pin `9fbb54b33e91ee4ca368e35a78e0613c720600b3` (stock caddy 2.11.4), GitHub Actions (`check.yml`, unchanged), Let's Encrypt ACME, restic-free verification via `openssl`/`curl`.

**Spec:** `docs/superpowers/specs/2026-08-28-stock-caddy-edge-design.md`

## Global Constraints

- **One atomic commit for Task 1.** Consumers still set the removed options (`fallback`, `mode`), so every intermediate state fails eval. Never split Task 1's diff across commits; CI must never see a red intermediate.
- **nixpkgs pin:** `9fbb54b33e91ee4ca368e35a78e0613c720600b3` (stock caddy 2.11.4, the latest upstream stable — no v3 branch or tag exists). Do not bump the pin.
- **The VPS must never compile caddy.** Stock caddy substitutes from `https://cache.nixos.org/`, which nixpkgs appends via `mkAfter` to every NixOS host's substituters (`nixos/modules/config/nix.nix` line 434 at the pin) — verified to hold for the VPS, whose `privateCache` sets its own substituters list. No cache marker (`passthru.cache`) goes on caddy.
- **CI workflow (`check.yml`) is unchanged.** The `cache = true` push loop keeps passing: photoform and encode_queue retain the marker, so the empty-list guard does not trip.
- **Out of scope (do not touch):** Stalwart's listener/ACME/firewall (stays on `192.168.100.41:443`, ACME deliberately kept on), photoform's container, DNS records, firewall topology, the `brianjs.com` apex (no A record — unclaimed by design). Only the comment changes in `modules/stalwart-server/nixos.nix` are allowed there.
- **Deploy only after CI is green and the `verified` ref has advanced to the merged commit.** Rollback is `sudo nixos-rebuild switch --rollback` on the VPS.
- **Format:** the repo formats with nixfmt-tree via the `nix fmt` wrapper (devShell); run it before committing.

---

### Task 1: Flip the edge to stock caddy (single commit)

**Files:**
- Modify (rewrite): `modules/caddy/nixos.nix`
- Delete: `modules/caddy/package.nix`
- Modify: `flake.nix:86` (drop `caddy-l4`), `flake.nix:134` (comment)
- Modify: `hosts/vps/default.nix:59-61` (stale comment), `hosts/vps/default.nix:76-82` (caddy block)
- Modify: `modules/photoform/nixos.nix:62-67` (drop `mode`)
- Modify: `tests/photoform.nix:36-40` (test host config), `tests/photoform.nix:148-155` (route assertion + new check)
- Modify: `modules/stalwart-server/nixos.nix:66-67` (comment)

**Interfaces:**
- Consumes: nixpkgs `services.caddy` at the pin — `virtualHosts.<name>.extraConfig` is `types.lines` (multi-line Caddyfile text rendered verbatim inside the site block); `services.caddy.email` renders `email <addr>` into the global block; default ports are 80/443, so no `http_port`/`https_port` lines render. `pkgs.caddy` is the stock 2.11.4 derivation.
- Produces: option `mine.system.caddy.routes.<name>` with exactly `{ hostnames: listOf str; target: str; extraConfig: nullOr str (default null) }` — `mode` and `fallback` no longer exist; `services.caddy.package = pkgs.caddy`; no `globalConfig`, no 8443. Every route renders one vhost per hostname whose `extraConfig` is `"reverse_proxy ${target}"` (or, when `extraConfig != null`, a block-form `reverse_proxy ${target} { …extraConfig… }`).

- [ ] **Step 1: Write the failing test**

Edit `tests/photoform.nix` in two places.

1a. Remove the `fallback` line from the test host's caddy config (lines 36-40) so it reads:

```nix
              caddy = {
                enable = true;
                acmeEmail = "test@example.com";
              };
```

1b. Replace the route assertion (lines 148-155), dropping the `mode` clause and adding a new stock-package check directly after it:

```nix
    {
      name = "the edge routes the booking hostname to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
    {
      # The edge terminates with stock nixpkgs caddy (substituted from
      # cache.nixos.org on the VPS), not a custom plugin build: the caddy-l4
      # build pinned this repo to plugin-vendor semantics and broke on
      # nixpkgs' Go bumps alone (2026-08-28).
      name = "the edge runs the stock caddy package";
      ok = host.services.caddy.package == pkgs.caddy;
    }
```

(`pkgs` is already bound at the top of this file as `nixpkgs.legacyPackages.${system}` — the same instance the module's `pkgs.caddy` resolves against.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `nix flake check .#x86_64-linux.photoform --print-build-logs`
Expected: FAIL — the `photoform-eval-tests` derivation prints `FAIL: the edge runs the stock caddy package` and exits 1 (the old module wires `pkgs.callPackage ./package.nix { }`, not `pkgs.caddy`). All other checks in this derivation pass.

- [ ] **Step 3: Rewrite the caddy module**

Replace the entire contents of `modules/caddy/nixos.nix` with:

```nix
# Generic SNI edge: stock Caddy owns host port 443 and is the sole TLS
# authority for every route it claims. Each route renders one vhost per
# claimed hostname, terminating with its own Let's Encrypt certificate
# (automatic ACME over the port 80 HTTP-01 lane) and reverse-proxying to
# the target. A route's `extraConfig` tunes the upstream transport — a
# TLS upstream needs `transport http { tls tls_insecure_skip_verify }`. Every
# connection no route claims (unknown SNI, no SNI) fails closed: it gets
# the default vhost's cert and a TLS name mismatch, never a data path.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
in
{
  options.mine.system.caddy = {
    enable = lib.mkEnableOption "SNI-routing Caddy edge owning host ports 80 and 443";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      description = "ACME account contact for certificates Caddy obtains.";
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
            target = lib.mkOption {
              type = lib.types.str;
              example = "192.168.100.51:8080";
              description = ''
                host:port (plain-HTTP upstream) or a full URL
                (https://host:port TLS upstream) behind this route.
              '';
            };
            extraConfig = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "transport http {\n\t\ttls\n\t\ttls_insecure_skip_verify\n\t}";
              description = ''
                Extra Caddyfile lines nested inside the route's
                block-form reverse_proxy, e.g. the upstream
                transport for a TLS target.
              '';
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

    # The ACME account key and issued certificates. Restoring them beats
    # re-issuing into Let's Encrypt's duplicate-certificate limit after a
    # rebuild. No container to stop: caddy writes JSON files, not a database.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/caddy" ];
    };

    services.caddy = {
      enable = true;
      # Stock nixpkgs caddy. The VPS substitutes it from cache.nixos.org,
      # which nixpkgs appends (mkAfter) to every NixOS host's substituters
      # — including this host's private-cache list — so the 1 GB box never
      # compiles it.
      package = pkgs.caddy;
      email = cfg.acmeEmail;
      # One vhost per hostname of every route; Caddy obtains and renews
      # their certificates automatically.
      virtualHosts = lib.mkMerge (
        lib.mapAttrsToList (
          _: r:
          lib.genAttrs r.hostnames (_: {
            extraConfig =
              if r.extraConfig != null then
                "reverse_proxy ${r.target} {\n${r.extraConfig}\n}"
              else
                "reverse_proxy ${r.target}";
          })
        ) cfg.routes
      );
    };
  };
}
```

Kept verbatim from the old module: `enable`, `acmeEmail`, the unique-hostname assertion, firewall 80/443, and the `/var/lib/caddy` backup registration. Deleted: `httpsPort = 8443`, `globalConfig` (layer4 block), the `fallback` option, the `mode` field, `routeBlock`, `layer4Server`, `tlsRoutes`.

- [ ] **Step 4: Delete the custom build and update the flake**

```bash
git rm modules/caddy/package.nix
```

Edit `flake.nix`:

4a. Delete line 86 so the `packages` attrset reads:

```nix
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
          photoform = pkgs.callPackage ./modules/photoform/package.nix { };
        }
```

4b. Line 134, reword the `caddyfile-*` check comment from layer4 terms to Caddyfile terms:

```nix
        # The eval-only host checks never render a Caddyfile, so a Caddyfile
        # syntax error would first surface on a deploy. Running the real
        # binary's adapter over every caddy host's config makes it a CI
        # failure instead. Generated, so a second caddy host is covered
        # the moment it enables the module.
```

(The `pkg-*` and `caddyfile-*` check generation loops are left as-is: `pkg-caddy-l4` disappears automatically with the attrset entry, and `caddyfile-vps` now runs the stock binary over the new shape, fetching it from `cache.nixos.org` on the CI runner.)

- [ ] **Step 5: Update the VPS host config**

Edit `hosts/vps/default.nix` in two places.

5a. Lines 59-61 — the stale "cannot compile caddy-with-l4" comment:

```nix
      # 1 GB of RAM cannot compile photoform: it carries
      # passthru.cache = true and must arrive as a substituted closure.
      # caddy is stock nixpkgs and substitutes from cache.nixos.org.
      privateCache.enable = true;
```

5b. Lines 76-82 — replace the fallback-only caddy block with the mail route:

```nix
      # SNI edge on 443: caddy is the sole TLS authority for every name it
      # claims. The mail route terminates with its own Let's Encrypt cert
      # and proxies back to Stalwart's public listener over TLS — Stalwart
      # keeps its own ACME and certs, caddy is only the public presenter
      # (two LE accounts then hold certs for the same names; deliberate).
      # The brianjs.com apex is unclaimed by design (no A record).
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
        routes.mail = {
          hostnames = [ "mx1.brianjs.com" ];
          target = "https://192.168.100.41:443";
          extraConfig = "transport http {\n\t\ttls\n\t\ttls_insecure_skip_verify\n\t}";
        };
      };
```

- [ ] **Step 6: Drop `mode` from photoform's route registration**

Edit `modules/photoform/nixos.nix` lines 62-67:

```nix
    mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
      routes.photoform = {
        hostnames = [ "booking.summerfieldphotography.com" ];
        target = "192.168.100.51:8080";
      };
    };
```

- [ ] **Step 7: Fix the stalwart-server comment**

Edit `modules/stalwart-server/nixos.nix` lines 66-67 (comment-only; the `!caddy.enable` DNAT conditional already encodes the new topology):

```nix
      # When the caddy edge owns host 443, its mx1 route is the only path
      # to Stalwart's public listener (caddy terminates TLS, then
      # reverse-proxies it over TLS); the mail-port forwards stay
      # unconditional.
```

- [ ] **Step 8: Run the photoform check to verify it passes**

Run: `nix flake check .#x86_64-linux.photoform --print-build-logs`
Expected: PASS (exit 0, no output) — both the updated route assertion and the new stock-package check hold.

- [ ] **Step 9: Eyeball the rendered vps Caddyfile**

```sh
out=$(nix build --print-out-paths .#nixosConfigurations.vps.config.services.caddy.configFile)
cat "$out/Caddyfile"
```

Expected (this first build fetches the stock caddy 2.11.4 binary from `cache.nixos.org`; the file passes through `caddy fmt`):

```
{
	email brianjsummerfield@gmail.com

	log {
		level ERROR
	}
}

booking.summerfieldphotography.com {
	log {
		output file /var/log/caddy/access-booking.summerfieldphotography.com.log
	}

	reverse_proxy 192.168.100.51:8080
}

mx1.brianjs.com {
	log {
		output file /var/log/caddy/access-mx1.brianjs.com.log
	}

	reverse_proxy https://192.168.100.41:443 {
		transport http {
			tls
			tls_insecure_skip_verify
		}
	}
}
```

The `mx1` vhost must carry the `reverse_proxy https://192.168.100.41:443` line with a nested `transport http { tls tls_insecure_skip_verify }` block; there must be no `layer4`, `:8443`, or raw `route { proxy … }` lines anywhere.

- [ ] **Step 10: Run the caddyfile and vps eval checks**

Run: `nix flake check .#x86_64-linux.caddyfile-vps .#x86_64-linux.nixos-vps --print-build-logs`
Expected: PASS — `caddy adapt` accepts the new shape with the stock binary, and the real vps config evaluates (mail route + photoform route coexist, unique-hostname assertion holds).

- [ ] **Step 11: Format and commit**

```bash
nix fmt
git add -A
git status
```

`git status` must show exactly: modified `flake.nix`, `hosts/vps/default.nix`, `modules/caddy/nixos.nix`, `modules/photoform/nixos.nix`, `modules/stalwart-server/nixos.nix`, `tests/photoform.nix`; deleted `modules/caddy/package.nix`; nothing else.

```bash
git commit -m "refactor(caddy): make every route a TLS route; drop the caddy-l4 build

Caddy is now the sole TLS authority for every route it claims: the
layer4 raw-byte fallback is deleted (unknown SNI fails closed with a
TLS name mismatch) and mx1.brianjs.com rides an ordinary TLS route with
a TLS-insecure upstream to Stalwart's public listener. The edge is
stock nixpkgs caddy 2.11.4, substituted from cache.nixos.org — the
custom build, its vendor hash, and the recurring Go-bump breakage class
are gone. Stalwart keeps its own ACME and certs; the apex stays
unclaimed (no A record).

Implements docs/superpowers/specs/2026-08-28-stock-caddy-edge-design.md"
```

---

### Task 2: Land the change (PR → CI → merge → verified ref)

**Files:** none (git/CI only).

**Interfaces:**
- Consumes: Task 1's commit on branch `plan/base-caddy`.
- Produces: the `verified` ref on `origin` pointing at the merged commit — this is what the VPS's `autoUpgrade` (`flake = "github:BJSummerfield/nixcfg/verified"`) tracks, and what Task 4 deploys.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin plan/base-caddy
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --title "refactor(caddy): make every route a TLS route; drop the caddy-l4 build" \
  --body "Implements docs/superpowers/specs/2026-08-28-stock-caddy-edge-design.md.

- Caddy is the sole TLS authority for every route it claims; the layer4 raw-byte fallback is deleted (unknown SNI now fails closed with a TLS name mismatch).
- mx1.brianjs.com rides an ordinary TLS route: caddy terminates with its own LE cert and reverse-proxies https://192.168.100.41:443 with a TLS-insecure upstream. Stalwart keeps its own ACME/certs; the apex stays unclaimed (no A record).
- The edge is stock nixpkgs caddy (2.11.4 at our pin), substituted from cache.nixos.org — the caddy-l4 build, its vendor hash, and the recurring Go-bump breakage class are gone. No CI workflow changes: photoform and encode_queue keep the cache marker, so the push loop's empty-list guard still passes.

Deploy (VPS): nixos-rebuild switch on the verified ref after CI is green; rollback with nixos-rebuild switch --rollback."
```

- [ ] **Step 3: Wait for CI green**

Run: `gh run watch --branch plan/base-caddy` (or `gh pr checks <number>` and poll)
Expected: the `check` job passes. Watch specifically for: `caddyfile-vps` (stock binary adapts the new Caddyfile), `photoform` (eval tests), `nixos-vps` (eval), and the push-to-cache step's empty-list guard (photoform + encode_queue still present). **Do not merge while any check is red.**

- [ ] **Step 4: Merge and confirm the verified ref advanced**

```bash
gh pr merge --merge
git ls-remote origin refs/heads/verified
```

Expected: the `verified` SHA equals the new `main` HEAD (the merge commit). If `ls-remote` shows the old SHA, the CI push step hasn't finished — wait and re-check before Task 3.

---

### Task 3: Pre-deploy diagnostics (record old state; does not gate)

Operator task: run on the VPS (ssh; 1 GB box) and from the devbox. Record every output — it is the baseline Task 4 is verified against.

**Interfaces:**
- Consumes: the live old caddy-l4 edge on the VPS.
- Produces: a recorded baseline (direct-to-Stalwart HTTP code, via-edge behavior, devbox TLS handshake outcome).

- [ ] **Step 1: On the VPS, record direct and via-edge behavior**

```sh
curl -sk -o /dev/null -w 'direct:  %{http_code}\n' https://192.168.100.41:443/
curl -sk -o /dev/null -w 'via-edge:%{http_code}\n' --resolve mx1.brianjs.com:443:127.0.0.1 https://mx1.brianjs.com/
```

Expected: `direct:  200`. `via-edge` is either `200` (fallback serving raw bytes) or `000` (handshake dies — corroborates the probe finding that the fallback path is broken; the spec's devbox probe saw EOF on it). Either outcome is acceptable; note which.

- [ ] **Step 2: From the devbox, record the external fallback probe**

```sh
curl -skI --max-time 10 https://mx1.brianjs.com/; echo "exit: $?"
```

Expected before deploy: the TLS handshake to `mx1.brianjs.com:443` (the fallback path from an external vantage point) dies — empty response with `exit: 52` (empty reply) or a TLS error. If it unexpectedly returns 200, the probe finding was vantage-specific; still fine to proceed, note it.

- [ ] **Step 3: Note the time**

Record when the baseline was taken. The deploy (Task 4) should happen at a quiet moment — the only 443 traffic that can transiently mismatch is `mx1.brianjs.com` mail-HTTPS during Caddy's startup cert issuance; IMAP 993 / SMTPS 465 / SMTP 25 bypass caddy entirely and are unaffected.

---

### Task 4: Deploy to the VPS and verify

Operator task on the VPS (ssh) and from the devbox. Prerequisite: Task 2 complete, Task 3 baseline recorded.

**Interfaces:**
- Consumes: the `verified` ref (Task 2) and the baseline (Task 3).
- Produces: the stock-caddy edge live on the VPS with the `mx1` TLS route; a recorded post-deploy verification pass.

**Rollback (any failure below):** `sudo nixos-rebuild switch --rollback` on the VPS. The VPS's local store holds the previous generation (GC-protected by the `/etc/system` profile roots), so the rollback reinstalls it without re-fetching; `/var/lib/caddy` state is compatible.

- [ ] **Step 1: Deploy**

On the VPS:

```sh
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified#vps
```

Expected: success, no local compilation of caddy (it substitutes from `cache.nixos.org`; the 1 GB limit only concerns photoform's app build, which the private cache serves). Watch the activation log for caddy starting and issuing the `mx1.brianjs.com` cert (http-01, seconds) — a brief window in which `mx1` traffic gets a mismatched cert is expected and harmless (IMAP/SMTPS unaffected).

- [ ] **Step 2: Both vhosts registered**

```sh
sudo caddy list-sites --config /etc/caddy/caddy_config
```

Expected: two sites — `booking.summerfieldphotography.com` and `mx1.brianjs.com`.

- [ ] **Step 3: ACME issuance for mx1**

```sh
journalctl -u caddy -S -15min | grep -iE 'mx1|cert'
```

Expected: Caddy's ACME log lines showing the `mx1.brianjs.com` certificate obtained/issued.

- [ ] **Step 4: Cert issuer is Let's Encrypt**

```sh
echo | openssl s_client -connect mx1.brianjs.com:443 -servername mx1.brianjs.com 2>/dev/null | openssl x509 -noout -issuer
```

Expected: a Let's Encrypt issuer line (e.g. `C = US, O = Let's Encrypt, CN = E5`) — clients validating against public roots notice nothing versus Stalwart's old LE cert.

- [ ] **Step 5: Mail HTTPS and booking regression (from the VPS)**

```sh
curl -sI https://mx1.brianjs.com/
curl -sI https://booking.summerfieldphotography.com/
```

Expected: `HTTP/2 200` (Stalwart web/JMAP) and `HTTP/2 200` (booking, regression check).

- [ ] **Step 6: Unknown SNI fails closed (from the devbox)**

```sh
curl -sI --max-time 10 --resolve unknown.example:443:178.104.51.195 https://unknown.example/; echo "exit: $?"
```

Expected: a TLS certificate/name-mismatch error (`exit: 60`) — the unmatched SNI gets a claimed name's cert and no data path. (Equivalently on the VPS: `echo | openssl s_client -connect 127.0.0.1:443 -servername unknown.example 2>/dev/null | openssl x509 -noout -subject` shows a claimed name, not `unknown.example`.)

- [ ] **Step 7: Devbox probe that EOF'd before now succeeds**

From the devbox:

```sh
curl -skI https://mx1.brianjs.com/
echo | openssl s_client -connect mx1.brianjs.com:443 -servername mx1.brianjs.com 2>/dev/null | openssl x509 -noout -issuer
```

Expected: `HTTP/2 200` and a Let's Encrypt issuer — this retroactively confirms the old fallback path was broken (Task 3 Step 2 showed the handshake dying from this same vantage point).

- [ ] **Step 8: Real mailbox round-trip (operator, from a real client)**

From Thunderbird/phone against the real mailbox: send a test message and fetch it — IMAP 993 (bypasses caddy; regression) and JMAP over `https://mx1.brianjs.com` (through the new route). Both must work before this migration is considered done.

- [ ] **Step 9: Confirm the nightlies**

Expected on the next autoUpgrade (04:00 window): the VPS pulls the same verified config with no caddy compilation and no behavior change. No action needed — just do not be surprised by a green autoUpgrade; if it is red, `sudo nixos-rebuild switch --rollback` and investigate.

---

## Self-Review

- **Spec coverage:** module rewrite (Task 1 Step 3) ✓; package.nix deletion + no wrapper/cache-marker rationale (Step 4, Global Constraints) ✓; flake `caddy-l4` drop + comment reword (Step 4) ✓; vps fallback drop + mail route + both stale comments (Step 5) ✓; photoform `mode` drop (Step 6) ✓; test `fallback`/`mode` drops (Step 1) ✓; stalwart comment (Step 7) ✓; behavior table (Task 4 Steps 5-7, unknown-SNI fail-closed) ✓; risks: transient mail-443 gap (Task 3 Step 3 + Task 4 Step 1), rollback (Task 4), cache ordering/CI-green-first (Task 2, Global Constraints), autoUpgrade pulls stock caddy from cache.nixos.org (Task 4 Step 9) ✓; verification: CI (Task 2 Step 3), pre-deploy diagnostic (Task 3), post-deploy checks incl. devbox probes (Task 4) ✓; out-of-scope items left untouched ✓.
- **Placeholder scan:** every step carries exact commands, file contents, or expected outputs; no "TBD"/"similar to Task N".
- **Type consistency:** the route option is `extraConfig: nullOr str` in the module, set in `hosts/vps/default.nix`, consumed in the vhost rendering (`r.extraConfig != null`); the test asserts `services.caddy.package == pkgs.caddy` exactly as the module sets it; `routes.mail` (vps) and `routes.photoform` (module) are the only two writers and both match the new `{ hostnames, target, extraConfig? }` shape.
