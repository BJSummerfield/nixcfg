# Stock Caddy edge: dropping the caddy-l4 build

Date: 2026-08-28
Status: design approved in chat; pending spec review
Hosts affected: `vps` only (sole user of `mine.system.caddy`)

## Problem

`modules/caddy/package.nix` compiles stock Caddy plus the out-of-tree plugin
`github.com/mholt/caddy-l4@v0.1.2` (layer-4 SNI routing, "Project Conncept").
The plugin exists because the VPS's public 443 carries two unrelated TLS
services distinguished only by SNI, and one of them (Stalwart's public
https/JMAP/CalDAV listener) rode the plugin's **raw-byte fallback** route.

That custom build is the fragile part of the repo:

- A nixpkgs Go toolchain bump alone (1.26.5 → 1.26.7) invalidated the plugin
  vendor hash on 2026-08-28 with caddy itself untouched (`bd38b3f`).
- The VPS (1 GB RAM) can never build it; it depends on CI building and
  pushing the exact derivation to the private B2 cache.
- caddy-l4 is the only thing pinning our repo to plugin-vendor semantics at
  all; stock nixpkgs Caddy (2.11.4 at our pin, also the latest upstream
  stable — no v3 branch or tag exists) has **no** in-tree layer4 app, which
  is why the plugin was load-bearing in the first place.

The probe also found the raw fallback path itself looks broken in
production: from the devbox, every TLS handshake to
`mx1.brianjs.com:443` (the fallback path; any SNI, TLS 1.2/1.3, old or new
ClientHellos) dies with EOF right after the ClientHello, while the same
hellos to caddy's terminated route succeed. A decisive on-VPS test (direct
`curl -sk` to `192.168.100.41:443`) was left pending. This migration makes
that finding moot: the raw fallback is deleted, and `mx1.brianjs.com` rides
the caddy-terminated path, which is verified working from the same vantage
point.

## Decision: make every route a TLS route (option A)

Stalwart's 443 listener is pure HTTPS (JMAP/CalDAV/webmail; IMAP 993, SMTPS
465 and SMTP 25 are DNATed straight to it and never pass through caddy;
Teamspeak is on 9987). Nothing on 443 needs raw bytes. So:

- Caddy becomes the **sole TLS authority** for everything it claims.
- The mail domain is enumerated as an ordinary TLS route with a TLS
  upstream; the raw fallback is deleted.
- The plugin, the custom build, and the 8443 handoff disappear. Stock
  Caddy owns 80/443 directly.

DNS facts (checked 2026-08-28 via dns.google):

- `mx1.brianjs.com` → 178.104.51.195 (the VPS). This is the MX target and
  the only name mail/HTTPS clients address.
- The `brianjs.com` apex has **no A record**, so nothing can reach it on
  443 — it is deliberately not claimed (Caddy also could not ACME it via
  http-01 without an A record).
- No `_mta-sts`, `autodiscover`, `mail`, `webmail`, or `jmap`
  subdomain records exist.

## Behavior after migration

| Traffic | Before | After |
|---|---|---|
| `booking.summerfieldphotography.com:443` | caddy TLS route → `192.168.100.51:8080` | unchanged |
| `mx1.brianjs.com:443` | layer4 fallback → raw bytes to `192.168.100.41:443` | caddy TLS route: terminates with its own LE cert, `reverse_proxy https://192.168.100.41:443` with `tls { insecure }` upstream |
| unknown/absent SNI on 443 | raw bytes to Stalwart | fails closed: unmatched SNI gets the default vhost's cert → TLS name mismatch; no data path |
| :80 | caddy HTTP-01 + redirect | unchanged |
| 25/465/993, 9987 | DNAT / direct | unchanged (never touched caddy) |

Consequences, accepted:

- Clients get Caddy's Let's Encrypt cert for `mx1.brianjs.com` instead of
  Stalwart's. Both are LE certs for the same name — clients validating
  against public roots notice nothing.
- **Stalwart keeps its own ACME and certs (deliberate, user constraint).**
  Caddy is only the public presenter. Two LE accounts then hold certs for
  the same names — fine, rate limits are per account. Documented in the
  config as a note, not automated.
- The only SNI that resolves to the VPS is claimed, so nothing legitimate
  loses a path by deleting the fallback.

## Changes, by file

1. **`modules/caddy/nixos.nix`** — rewrite. Drop the layer4
   `globalConfig`, the 8443 `httpsPort`, the `fallback` option, and the
   `mode` field. Routes become `{ hostnames, target, extraConfig? }`;
   every route renders one vhost per hostname with
   `reverse_proxy ${target}` plus optional `extraConfig` lines. Kept
   verbatim: `enable`, `acmeEmail`, the unique-hostname assertion, firewall
   80/443, and the `/var/lib/caddy` backup registration. `package` stays
   `pkgs.callPackage ./package.nix { }`.

2. **`modules/caddy/package.nix`** — rewrite (not delete): stock
   `pkgs.caddy` with `passthru.cache = true`. The marker is load-bearing:
   the VPS's only substituter is the private B2 cache (its
   `nix.settings.substituters` *replaces* the default, so `cache.nixos.org`
   is not reachable from the VPS) and 1 GB of RAM cannot compile a Go
   build. CI's push step uploads exactly the derivations in `packages`
   with `cache = true`, so the flake and the module must reference the
   same derivation — hence the shared `package.nix`, same as today.
   Side effect: the recurring vendor-hash breakage class goes away;
   nixpkgs owns the caddy build and its hashes.

3. **`flake.nix`** — `packages.caddy-l4` → `packages.caddy` (same
   `callPackage ./modules/caddy/package.nix`); update the comment that
   explains the `caddyfile-*` checks in terms of layer4 syntax. The
   generated `pkg-caddy` check then builds the stock wrapper, and the
   existing `caddyfile-vps` check validates the new Caddyfile shape with
   the stock binary.

4. **`hosts/vps/default.nix`** — drop `fallback`; add the mail route:
   ```nix
   caddy.routes.mail = {
     hostnames = [ "mx1.brianjs.com" ];
     target = "https://192.168.100.41:443";
     extraConfig = "transport http { tls { insecure } }";
   };
   ```
   with a comment carrying the two deliberate facts: Stalwart keeps its
   own ACME/cert (caddy is the public presenter only), and the apex is
   unclaimed by design (no A record). Also update the two stale comments
   ("Fallback-only until photoform lands"; "cannot compile caddy-with-l4").

5. **`modules/photoform/nixos.nix`** — drop `mode = "tls"` from the route
   registration.

6. **`tests/photoform.nix`** — drop `fallback` from the test host's
   caddy config; the route assertion drops the `mode` check (hostnames +
   target remain).

7. **`modules/stalwart-server/nixos.nix`** — comment-only: the DNAT
   conditional (`!caddy.enable` gates the 443 forward) already encodes the
   new topology; fix the comment that says the layer4 fallback "replaces
   this DNAT byte-for-byte".

No changes: Stalwart's listener (stays on `192.168.100.41:443`), its
ACME, its firewall ports, photoform's container, the CI workflow
mechanics (the `cache = true` push loop works unchanged).

## Rendered Caddyfile (vps, after)

```
{
	email brianjsummerfield@gmail.com
}

booking.summerfieldphotography.com {
	reverse_proxy 192.168.100.51:8080
}

mx1.brianjs.com {
	reverse_proxy https://192.168.100.41:443
	transport http {
		tls {
			insecure
		}
	}
}
```

## Risks and mitigations

- **Transient mail-443 gap at deploy**: Caddy must issue the new LE cert
  for `mx1.brianjs.com` at startup (http-01; seconds). During that window
  the name gets the default vhost's cert → mismatch. Single-user box;
  deploy at a quiet moment. IMAP/SMTPS are unaffected (bypass caddy).
- **Rollback**: `nixos-rebuild switch --rollback` on the VPS. The old
  config keeps working: the caddy-l4 derivation remains in the private
  cache and `/var/lib/caddy` state is compatible.
- **Cache ordering**: the VPS must not `switch` before CI's main push
  (checks → push-to-cache → ref advance) has landed, or it will try to
  compile caddy locally. Same contract as today's custom build.
- **Pre-existing, unchanged**: nightly autoUpgrade after a nixpkgs pin
  move follows the same CI-pushes-first contract as the current build.

## Verification

CI (before the VPS touches anything):

- `pkg-caddy` builds the stock wrapper; `caddyfile-vps` runs
  `caddy adapt` over the new shape with the stock binary; the photoform
  eval test host still evaluates.

Pre-deploy diagnostic on the VPS (records the old state; does not gate):

```sh
curl -sk -o /dev/null -w 'direct:  %{http_code}\n' https://192.168.100.41:443/
curl -sk -o /dev/null -w 'via-edge:%{http_code}\n' --resolve mx1.brianjs.com:443:127.0.0.1 https://mx1.brianjs.com/
```

Post-deploy on the VPS:

- `caddy list-sites` shows both vhosts; ACME log shows the `mx1` issue.
- `openssl s_client -servername mx1.brianjs.com` → Let's Encrypt issuer.
- `curl -sI https://mx1.brianjs.com/` → 200 (Stalwart web/JMAP).
- `curl -sI https://booking.summerfieldphotography.com/` → 200 (regression).
- Unknown SNI → TLS name mismatch (fails closed).
- Real mailbox round-trip from a client (Thunderbird/phone), JMAP and IMAP.
- From the devbox: the same probes that EOF'd on the old fallback path now
  succeed — this also retroactively confirms the fallback was broken.

## Out of scope

- haproxy/nginx `stream` alternative (considered, rejected: adds a second
  edge daemon and a duplicated SNI registry instead of removing one).
- Claiming the `brianjs.com` apex (no A record; revisit if one is ever
  added).
- Turning off Stalwart's ACME (explicitly kept on).
- Any Stalwart, photoform, DNS, or firewall-topology change beyond the
  comments listed above.
