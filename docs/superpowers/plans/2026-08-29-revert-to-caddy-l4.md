# Revert To The caddy-l4 SNI Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the layer4 SNI edge so Stalwart terminates its own TLS on :443 and renews over TLS-ALPN-01 again, deleting PR #143's certificate pipeline entirely.

**Architecture:** Two commits, each leaving `nix flake check` green. Task 1 reverts #143, returning the tree byte-for-byte to the #140 merge. Task 2 restores the caddy-l4 package and the layer4 module, makes `mx1.brianjs.com` an explicit `tcp` passthrough route owned by the stalwart module, and drops the `fallback` option so unclaimed connections are closed at the edge instead of funneled into Stalwart. Task 3 is operator work on the VPS.

**Tech Stack:** NixOS flake, nixpkgs pin `9fbb54b33e91ee4ca368e35a78e0613c720600b3`, caddy 2.11.4 + `github.com/mholt/caddy-l4@v0.1.2`, stalwart 0.15.5, sops-nix.

**Spec:** `docs/superpowers/specs/2026-08-29-revert-to-caddy-l4-design.md`

## Global Constraints

- **Do not bump the nixpkgs pin.** `9fbb54b33e91ee4ca368e35a78e0613c720600b3`. The caddy-l4 vendor hash `sha256-C+ksbA6ucY3GUsYHSUhkYoh1gTP8SIAJv0MLjhX8BQM=` is only valid against this pin — a bump invalidates it and `pkg-caddy-l4` fails.
- **The VPS must never compile caddy-l4 or photoform.** Both carry `passthru.cache = true` and must arrive as substituted closures. The 1 GB box cannot build them.
- **Format before committing:** the repo formats with nixfmt-tree via `nix fmt` (devShell).
- **Deploy only after CI is green and the `verified` ref has advanced.** `verified` advances on push to main (`.github/workflows/check.yml:131-133`), not on PR runs — so the PR must be merged first. Rollback is `sudo nixos-rebuild switch --rollback`.
- **Do not touch `letsencrypt-1`** in Stalwart's admin UI. It stayed enabled throughout #143, its certificate is valid to 2026-11-03 with renewal due 2026-10-04, and it resumes working the moment :443 is passthrough.
- **Out of scope (do not touch):** the `brianjs.com` apex (no A record, unclaimed by design), the mail-port forwards (25/465/993), photoform's container config, and `modules/devbox/` or `tests/devboxes.nix` (their diffs in #140 were `nix fmt` drift, not caddy work).

---

### Task 1: Revert PR #143

Return the four files #143 touched to their state at the #140 merge, and delete the test it added. This leaves a working stock-caddy edge — the tree is exactly commit `9208889` — so it is independently verifiable before any layer4 work begins.

**Files:**
- Modify (restore): `modules/caddy/nixos.nix`, `modules/stalwart-server/nixos.nix`, `hosts/vps/default.nix`, `flake.nix`
- Delete: `tests/stalwart.nix`

**Interfaces:**
- Produces: a tree with no `mine.system.caddy.certExports` option, no `mine.system.stalwart-server.apiKeyFile` option, no `stalwart-certs` group, and no `checks.x86_64-linux.stalwart`.

- [ ] **Step 1: Restore the four files from the pre-#143 commit**

`565f659` is the tip of the #140 branch, and the only changes to these files between it and `main` are #143's. So a checkout of that revision is an exact revert — no hand-editing, no risk of missing a hunk.

```bash
git checkout 565f659 -- \
  modules/caddy/nixos.nix \
  modules/stalwart-server/nixos.nix \
  hosts/vps/default.nix \
  flake.nix
git rm tests/stalwart.nix
```

- [ ] **Step 2: Verify the revert is exact**

Run:
```bash
git diff 9208889 -- modules hosts flake.nix tests
```
Expected: **no output.** The working tree now matches the #140 merge commit for all code. (`docs/` will differ — it holds this plan and the spec — which is why the path list excludes it.)

If there is output, something else changed those files between `565f659` and `main` and this plan's assumption is wrong. Stop and report rather than hand-patching.

- [ ] **Step 3: Verify the flake still evaluates**

Run: `nix flake check --print-build-logs`
Expected: PASS, all checks. `stalwart` is gone from the check list; `caddyfile-vps` and `nixos-vps` both pass.

- [ ] **Step 4: Commit**

```bash
nix fmt
git add -A modules hosts flake.nix tests
git commit -m "revert(stalwart): drop the caddy certificate pipeline

The published certificate could never be consumed: %{file:...}% does not
expand for database-stored settings, and caddy issues SEC1 EC keys that
stalwart 0.15.5 cannot parse (it accepts only RSA and PKCS#8). Rather
than add a transcode step and move the certificate config into Nix, the
next commit removes the port conflict that made any of this necessary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Restore the layer4 edge

**Files:**
- Create: `modules/caddy/package.nix`
- Modify: `modules/caddy/nixos.nix` (full rewrite), `modules/stalwart-server/nixos.nix`, `modules/photoform/nixos.nix`, `hosts/vps/default.nix`, `flake.nix`, `tests/photoform.nix`

**Interfaces:**
- Produces: `mine.system.caddy.routes.<name>` gains a required `mode` option (`"tls" | "tcp"`) and loses `extraConfig`; the `fallback` option does not exist. `tls` routes render a vhost and are proxied to caddy's internal HTTPS server on `127.0.0.1:8443`; `tcp` routes render no vhost and are proxied raw to their `target`.
- Consumes: nothing from Task 1 beyond its clean tree.

- [ ] **Step 1: Restore the caddy-l4 package**

```bash
git checkout bd38b3f -- modules/caddy/package.nix
```

This is a byte-identical restore. Confirm the vendor hash survived:

```bash
grep hash modules/caddy/package.nix
```
Expected: `hash = "sha256-C+ksbA6ucY3GUsYHSUhkYoh1gTP8SIAJv0MLjhX8BQM=";`

- [ ] **Step 2: Rewrite the caddy module**

Replace the entire contents of `modules/caddy/nixos.nix` with:

```nix
# Generic SNI edge: a layer4 listener owns host 443 and routes by
# ClientHello SNI — "tls" routes hand off to Caddy's own HTTPS server
# (automatic ACME, reverse_proxy), "tcp" routes are raw byte proxies that
# let the backend terminate its own TLS. Every connection no route claims
# (unknown SNI, no SNI, non-TLS) is closed at the edge: there is no
# fallback, so internet scan traffic never reaches a backend. An earlier
# revision proxied unclaimed connections to Stalwart, which auto-banned
# the veth gateway and took webmail down with it.
#
# Port 80 is Caddy's own HTTP-01 lane. A "tcp" route's backend needs a
# challenge path of its own — for Stalwart that is TLS-ALPN-01, which
# works precisely because layer4 matches SNI before forwarding any bytes.
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
  layer4Server = lib.concatStrings (lib.mapAttrsToList routeBlock cfg.routes);
  tlsRoutes = lib.filterAttrs (_: r: r.mode == "tls") cfg.routes;
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
            mode = lib.mkOption {
              type = lib.types.enum [
                "tls"
                "tcp"
              ];
              description = ''
                tls: Caddy terminates (automatic ACME) and reverse-proxies
                plain HTTP to target. tcp: encrypted passthrough, leaving
                target to terminate and renew its own certificate.
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
      {
        # A layer4 sni matcher with no names matches nothing and genAttrs
        # over an empty list yields no vhost, so such a route would
        # silently claim nothing rather than fail.
        assertion = lib.all (r: r.hostnames != [ ]) (lib.attrValues cfg.routes);
        message = "mine.system.caddy: a route claims no hostnames and would render nothing";
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
      # and renews their certificates automatically. "tcp" routes are
      # absent by design — their backend owns the certificate, and a vhost
      # here would make caddy race it for the same name.
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

- [ ] **Step 3: Give photoform's route its mode**

In `modules/photoform/nixos.nix`, in the `routes.photoform` block, add `mode` between `hostnames` and `target`:

```nix
      routes.photoform = {
        hostnames = [ "booking.summerfieldphotography.com" ];
        mode = "tls";
        target = "192.168.100.51:8080";
      };
```

- [ ] **Step 4: Register the mail passthrough route in the stalwart module**

In `modules/stalwart-server/nixos.nix`, add to `config`, directly after the `mine.backups` block:

```nix
    # The edge passes mx1 through untouched rather than terminating it.
    # Stalwart's certificate also serves 25/465/993, which bypass caddy
    # entirely, and TLS-ALPN-01 is the only challenge it can use — DNS-01
    # supports Cloudflare/TSIG/SIG0 only and this domain is at Namecheap.
    # That challenge needs the raw ClientHello on :443 to answer, which is
    # exactly what a tcp route preserves.
    mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
      routes.mail = {
        hostnames = [ "mx1.brianjs.com" ];
        mode = "tcp";
        target = "192.168.100.41:443";
      };
    };
```

Then fix the now-stale comment above `forwardPorts` in the same file. Replace:

```nix
      # When the caddy edge owns host 443, its mx1 route is the only path
      # to Stalwart's public listener (caddy terminates TLS, then
      # reverse-proxies it over TLS); the mail-port forwards stay
      # unconditional.
```

with:

```nix
      # When the caddy edge owns host 443, its mx1 route is the only path
      # to Stalwart's public listener — a raw passthrough, so Stalwart
      # still terminates its own TLS; the mail-port forwards stay
      # unconditional.
```

- [ ] **Step 5: Simplify the host's caddy block**

In `hosts/vps/default.nix`, replace the whole comment block and `caddy = { ... };` (the comment starting `# SNI edge on 443:` through the closing `};` of the caddy attribute) with:

```nix
      # SNI edge on 443: a layer4 listener routes by ClientHello SNI.
      # booking.summerfieldphotography.com terminates at caddy;
      # mx1.brianjs.com passes through untouched, so Stalwart terminates
      # and renews its own certificate — the one that also serves
      # 25/465/993. Both routes are registered by their service modules.
      # Every unclaimed connection is closed at the edge, and the
      # brianjs.com apex is unclaimed by design (no A record).
      caddy = {
        enable = true;
        acmeEmail = "brianjsummerfield@gmail.com";
      };
```

Also update the `privateCache` comment a few lines above. Replace:

```nix
      # 1 GB of RAM cannot compile photoform: it carries
      # passthru.cache = true and must arrive as a substituted closure.
      # caddy is stock nixpkgs and substitutes from cache.nixos.org.
```

with:

```nix
      # 1 GB of RAM cannot compile caddy-with-l4 or photoform: both carry
      # passthru.cache = true and must arrive as substituted closures.
```

- [ ] **Step 6: Restore the caddy-l4 package output**

In `flake.nix`, in the `packages` attribute set, add the `caddy-l4` line above `photoform`:

```nix
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
          caddy-l4 = pkgs.callPackage ./modules/caddy/package.nix { };
          photoform = pkgs.callPackage ./modules/photoform/package.nix { };
```

This is what creates the `pkg-caddy-l4` check, which is the CI gate on the vendor hash.

In the same file, restore the word "layer4" in the caddyfile-check comment. Replace `# The eval-only host checks never render a Caddyfile, so a Caddyfile` with:

```nix
        # The eval-only host checks never render a Caddyfile, so a layer4
```

- [ ] **Step 7: Add a synthetic passthrough route to the photoform test**

`tests/photoform.nix` is the only eval test that exercises the caddy module, and passthrough is now the module's most load-bearing behaviour. Add a second route to the test host so both modes are covered.

In the test host's `mine.system.caddy` block, replace:

```nix
              caddy = {
                enable = true;
                acmeEmail = "test@example.com";
              };
```

with:

```nix
              caddy = {
                enable = true;
                acmeEmail = "test@example.com";
                # A synthetic passthrough, standing in for the mail route.
                # The mail route itself is registered by the stalwart
                # module, which this test host does not import — but the
                # behaviour under test belongs to the caddy module.
                routes.passthrough = {
                  hostnames = [ "mx1.example.com" ];
                  mode = "tcp";
                  target = "192.168.100.41:443";
                };
              };
```

- [ ] **Step 8: Replace the stock-caddy check with layer4 checks**

In `tests/photoform.nix`, add `mode` to the existing route check. Replace:

```nix
      name = "the edge routes the booking hostname to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
```

with:

```nix
      name = "the edge routes the booking hostname to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.mode == "tls"
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
```

Then replace the entire "the edge runs the stock caddy package" check — comment and all, from `# The edge terminates with stock nixpkgs caddy` through its closing `}` — with these four:

```nix
    {
      # The layer4 app is an out-of-tree plugin, so the edge cannot be
      # stock nixpkgs caddy. pkg-caddy-l4 is the CI gate on the vendor
      # hash; this is the gate on the module actually using the build.
      name = "the edge runs the caddy-l4 build, not stock caddy";
      ok = host.services.caddy.package != pkgs.caddy;
    }
    {
      name = "a tls route is matched by SNI and handed to caddy's own HTTPS server";
      ok =
        lib.hasInfix "@photoform tls sni booking.summerfieldphotography.com" gc
        && lib.hasInfix "proxy 127.0.0.1:8443" gc;
    }
    {
      # The defining property of the mail path: layer4 hands the raw
      # connection to the backend, so the backend can answer TLS-ALPN-01
      # itself. Terminating here is what broke Stalwart's renewal.
      name = "a tcp route is proxied raw to its target";
      ok =
        lib.hasInfix "@passthrough tls sni mx1.example.com" gc
        && lib.hasInfix "proxy 192.168.100.41:443" gc;
    }
    {
      # If caddy rendered a vhost for a passthrough hostname it would try
      # to obtain that certificate itself, racing the backend for the same
      # name and consuming its duplicate-certificate budget.
      name = "a tcp route gets no vhost, so caddy never issues for it";
      ok =
        host.services.caddy.virtualHosts ? "booking.summerfieldphotography.com"
        && !(host.services.caddy.virtualHosts ? "mx1.example.com");
    }
```

Those three new checks read `gc`. Add it to the `let` block, next to the existing `host` binding:

```nix
  gc = host.services.caddy.globalConfig;
```

- [ ] **Step 9: Run the photoform test**

Run: `nix build .#checks.x86_64-linux.photoform --print-build-logs`
Expected: PASS.

If `a tcp route gets no vhost` fails, `tlsRoutes` is not filtering — check the `mode` comparison in Step 2. If `the edge runs the caddy-l4 build` fails, Step 2's `package` line is still `pkgs.caddy`.

- [ ] **Step 10: Build the plugin and check the whole flake**

Run: `nix flake check --print-build-logs`
Expected: PASS, including `pkg-caddy-l4` and `caddyfile-vps`.

`pkg-caddy-l4` is a real build. If the private cache still holds it from before #140 it substitutes in seconds; otherwise it compiles caddy with the plugin locally, which takes a few minutes. That is expected and fine — this is not the VPS. A **hash mismatch** here, rather than a slow build, means the vendor hash no longer matches the pin; stop and report, do not update the hash without checking why the pin moved.

`caddyfile-vps` is the check that matters most: it runs the l4 binary's own adapter over the rendered vps config, so an unknown `layer4` directive or a malformed matcher fails here rather than on deploy.

- [ ] **Step 11: Read the rendered Caddyfile**

Run:
```bash
nix build .#checks.x86_64-linux.caddyfile-vps --print-out-paths --no-link
```
then `cat` that path, or more directly:

```bash
nix eval --raw .#nixosConfigurations.vps.config.services.caddy.globalConfig
```

Expected — a `route` for each of the two hostnames, mail proxied to the container and photoform to the internal port, and **no fallback route**:

```
http_port 80
https_port 8443
layer4 {
  :443 {
    @mail tls sni mx1.brianjs.com
    route @mail {
      proxy 192.168.100.41:443
    }
    @photoform tls sni booking.summerfieldphotography.com
    route @photoform {
      proxy 127.0.0.1:8443
    }
  }
}
```

A bare `route { ... }` with no matcher would mean a fallback survived and unclaimed traffic still reaches a backend. There must not be one.

- [ ] **Step 12: Commit and open the PR**

```bash
nix fmt
git add modules/caddy/package.nix modules/caddy/nixos.nix \
        modules/stalwart-server/nixos.nix modules/photoform/nixos.nix \
        hosts/vps/default.nix flake.nix tests/photoform.nix
git commit -m "feat(caddy): restore the layer4 SNI edge, without the fallback

Stalwart's certificate serves 25/465/993, which bypass caddy entirely,
and TLS-ALPN-01 is the only challenge it can use — so it needs the raw
ClientHello on :443. A tcp route gives it that; terminating at the edge
did not, and left mail TLS with no renewal path at all.

The fallback does not come back. It sent every unclaimed connection into
Stalwart from the veth gateway, which is what got that address auto-banned
and 502'd webmail. Stalwart is now an explicit route owned by its own
module, and unclaimed connections are closed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin plan/revert-to-caddy-l4
gh pr create --fill
```

---

### Task 3: Deploy and verify

Operator task, on the VPS and in Stalwart's admin UI. Prerequisite: Task 2's PR merged, CI green, `verified` advanced.

**Interfaces:**
- Consumes: the merged configuration.
- Produces: Stalwart terminating its own TLS on :443 with a working TLS-ALPN-01 renewal path, and unclaimed connections closed at the edge.

**Rollback:** `sudo nixos-rebuild switch --rollback`. Nothing here is database-managed except the three UI steps below, and only `use-x-forwarded` would need undoing on a rollback.

- [ ] **Step 1: Record the current state**

```sh
curl -v --max-time 5 https://mx1.brianjs.com/ 2>&1 | grep -Ei 'expire date|issuer:'
sudo systemctl is-active caddy container@stalwart
```

Expected: caddy's certificate (issued after #140), and both units active. Note the expiry — after cutover this must change to Stalwart's own certificate.

- [ ] **Step 2: Clean up the admin UI**

Do these before deploying; nothing reads them afterwards and one is actively harmful.

1. **Server → API keys:** delete `certmanager`.
2. **Server → TLS → Certificates:** delete the `mx1` record if present. It never worked — it failed with `Build error for "certificate.mx1": No certificates found` — and leaving it would fight the ACME-obtained certificate.
3. **Turn `use-x-forwarded` off** ("Obtain remote IP from Forwarded header"). It was enabled when caddy terminated and set that header. Under passthrough nothing sets it, so leaving it on means trusting a header no trusted proxy is writing.

**Do not touch `letsencrypt-1`.**

- [ ] **Step 3: Deploy**

```sh
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified#vps
```

Expected: success with no local compilation — caddy-l4 substitutes from the private cache. If it starts compiling caddy, stop it: the box has 1 GB of RAM and will OOM. That would mean CI did not push the build to the cache.

The stalwart container is not restarted by this change; caddy is.

- [ ] **Step 4: Confirm webmail is passthrough**

```sh
curl -v --max-time 5 https://mx1.brianjs.com/ 2>&1 | grep -Ei 'expire date|issuer:'
```

Expected: the dates now match Stalwart's own certificate, not the one recorded in Step 1. This is the cutover.

- [ ] **Step 5: Confirm the booking site still terminates at caddy**

```sh
curl -v --max-time 5 https://booking.summerfieldphotography.com/ 2>&1 | grep -Ei 'expire date|issuer:|HTTP/'
```

Expected: a valid caddy-issued certificate and an HTTP response. This is the route that did *not* change; a failure here means the `tls` mode path regressed.

- [ ] **Step 6: Confirm unclaimed SNI is closed, not forwarded**

The edge case this whole design exists to fix. From any machine:

```sh
openssl s_client -connect mx1.brianjs.com:443 -servername nonsense.example.com </dev/null
openssl s_client -connect mx1.brianjs.com:443 </dev/null
```

Expected: both fail — connection closed, no certificate served. Then confirm nothing reached the backend:

```sh
sudo nixos-container run stalwart -- journalctl -u stalwart --since "5 minutes ago" --no-pager | grep -i "192.168.100.40"
```

Expected: no new connection entries from the gateway for those probes. If Stalwart logged them, a fallback survived — check Task 2 Step 11.

- [ ] **Step 7: Confirm mail still works**

From a real client, send and fetch a message over IMAP 993 and SMTP 465, and check the certificate presented. These ports bypass caddy entirely and are the reason this change exists — a working webmail page proves nothing about them.

- [ ] **Step 8: Confirm ACME is alive again**

```sh
sudo nixos-container run stalwart -- journalctl -u stalwart -n 60 --no-pager | grep -iE 'acme|tls-alpn'
```

Expected: `Processing ACME certificate (acme.process-cert) id = "letsencrypt-1"` with a `due` date, and **no** `acme.tls-alpn-error` entries.

This is the point of the change, so prove it rather than waiting for 2026-10-04. Force a renewal from the admin UI (Server → TLS → ACME Providers → `letsencrypt-1`) and confirm a new certificate is issued and served. If the renewal fails, the passthrough is not reaching Stalwart intact — re-check Step 6's routing.

- [ ] **Step 9: Confirm the gateway is not banned**

After some normal webmail use, check Stalwart's blocked-IP list for `192.168.100.40`. Layer4 passthrough carries no client address, so all webmail connections appear to come from the gateway.

Expected: absent. If it reappears, allow-list it in Stalwart's security settings — and note that deleting a `BlockedIp` entry needs `systemctl restart container@stalwart` to take effect.

- [ ] **Step 10: Remove the leftover host state**

```sh
sudo rm -rf /var/lib/stalwart-certs
sudo groupdel stalwart-certs
```

NixOS does not remove groups when their declaration disappears, so `groupdel` is manual. A "group does not exist" error is fine.

- [ ] **Step 11: Drop the unused sops key**

```sh
nix develop -c sops secrets/hosts/vps.yaml
```

Remove the `stalwart-api-key` entry, then commit and push. Nothing has read it since Task 1 removed the `sops.secrets` declaration, so this is tidying rather than a security fix — but leave it and the next person will wonder what reads it.

---

## Self-Review

- **Spec coverage:** revert of #143 across all five files (Task 1) ✓; caddy-l4 package restored with the pinned vendor hash (Task 2 Step 1) ✓; layer4 module restored, `fallback` and `extraConfig` dropped, hostnames assertion kept (Task 2 Step 2) ✓; photoform `mode = "tls"` (Step 3) ✓; stalwart owns an explicit `tcp` route (Step 4) ✓; host caddy block reduced and both stale comments rewritten (Step 5) ✓; `caddy-l4` package output and the layer4 comment in `flake.nix` (Step 6) ✓; `tests/photoform.nix` covers both modes and the no-vhost-for-tcp property (Steps 7-8) ✓; rendered Caddyfile matches the spec's expected output and is read back (Step 11) ✓; operator cleanup including `use-x-forwarded` (Task 3 Step 2), `/var/lib/stalwart-certs` and `groupdel` (Step 10), sops key (Step 11) ✓; all six of the spec's verification items (Task 3 Steps 4-9) ✓.
- **Placeholder scan:** every step has exact paths, complete literal Nix, or exact commands with expected output. No "TBD", no "similar to Task N".
- **Type consistency:** `mode` is `"tls" | "tcp"` in the option (Task 2 Step 2), set in photoform (Step 3) and stalwart (Step 4), and asserted in the tests (Step 8). Route key `mail` is used in Task 2 Step 4 and appears as `@mail` in the expected Caddyfile (Step 11). `httpsPort = 8443` renders as `proxy 127.0.0.1:8443` in Step 8's assertion and Step 11's expected output. `gc` is defined in Step 8 and used only by checks added in that same step.
- **Deliberate difference from the spec:** the spec said `tests/photoform.nix` would restore its `mode` assertion and swap the package check. The plan goes further and adds a synthetic `tcp` route plus three rendering checks, because deleting `tests/stalwart.nix` would otherwise leave the passthrough path — the whole point of the change — with no eval coverage at all.
- **Known gap, carried from the spec:** restoring caddy-l4 re-exposes the repo to vendor-hash breakage on nixpkgs Go bumps. `pkg-caddy-l4` turns that into a CI failure and hosts stay on their last good build, but the hash update is manual. Accepted knowingly.
