# Stock Caddy edge: dropping the caddy-l4 build

Date: 2026-08-28
Status: implemented on branch plan/base-caddy (2026-08-28); transport syntax corrected to the caddy 2.11.4 block form; revised 2026-08-29 after an adversarial review (verified upstream TLS, corrected fails-closed and rate-limit claims, added the Stalwart ACME / X-Forwarded-For deploy blockers)
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
`curl -sk` to `192.168.100.41:443`) was left pending, so the root cause is
**not** established. Treat this as a symptom, not as evidence: an abrupt
death right after the ClientHello is also exactly what Caddy does for an
unmatched SNI (see the behavior table below), so the same observation fits
"mx1 was reaching Caddy's HTTPS server instead of the l4 fallback". That
alternative matters, because it would mean Stalwart's own TLS-ALPN-01
renewals are already failing today. The migration stands on the
custom-build argument above regardless; it does not rest on this probe.

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
| `mx1.brianjs.com:443` | layer4 fallback → raw bytes to `192.168.100.41:443` | caddy TLS route: terminates with its own LE cert, `reverse_proxy https://192.168.100.41:443` with a `transport http` upstream that verifies Stalwart's own cert (`tls_server_name mx1.brianjs.com`) |
| unknown/absent SNI on 443 | raw bytes to Stalwart | fails closed at the handshake: no default vhost and no on-demand issuance, so Caddy serves no certificate and aborts with a TLS `internal_error` alert (alert 80). No data path. |
| :80 | caddy HTTP-01 + redirect | unchanged |
| 25/465/993, 9987 | DNAT / direct | unchanged (never touched caddy) |

Consequences, accepted:

- Clients get Caddy's Let's Encrypt cert for `mx1.brianjs.com` instead of
  Stalwart's. Both are LE certs for the same name — clients validating
  against public roots notice nothing.
- **Stalwart keeps its own ACME and certs (deliberate, user constraint).**
  Caddy is only the public presenter. Two LE issuers then hold certs for
  overlapping names. That is safe here, but *not* because "rate limits are
  per account" — Let's Encrypt's Duplicate Certificate limit (5/week) is
  keyed on the **exact set of names**, across accounts. It is safe because
  the sets differ: Caddy issues for `[mx1.brianjs.com]`, Stalwart for
  `[brianjs.com, mx1.brianjs.com]`. Adding the apex to Caddy would collide
  the buckets.
- **Stalwart has no ACME challenge path left, and this is a deploy
  blocker, not an accepted consequence.** Caddy owns :80 (so HTTP-01 is
  gone) and terminates :443 (so TLS-ALPN-01 is gone); before this change
  the l4 fallback handed unmatched-SNI 443 bytes to Stalwart, which gave
  TLS-ALPN-01 a path. Caddy and Stalwart also cannot share HTTP-01 for the
  same `mx1.brianjs.com`. Only DNS-01 survives. This matters well beyond
  the web listener: Stalwart's cert also serves 25/465/993, which bypass
  Caddy entirely, so a silent renewal failure surfaces as broken mail TLS
  up to 90 days after a deploy that looked green. **Confirm Stalwart's
  configured challenge type before deploying** (see Verification).
- **Client IPs collapse to the gateway.** Every webmail/JMAP/CalDAV
  request now reaches Stalwart from `192.168.100.40` instead of the real
  client. Stalwart's auth-failure banning and rate limits key on source
  IP, so an internet brute-force against webmail can get the *gateway*
  banned and lock out every HTTP user at once; access logs lose client IP
  too. Caddy already sends `X-Forwarded-For`; Stalwart's `use-x-forwarded`
  must be turned on in the same window as the deploy (it is DB-managed, so
  a UI step, not Nix). Trusting XFF without a proxy in front is worse than
  either end state, so the two changes go together.
- The only SNI that resolves to the VPS is claimed, so nothing legitimate
  loses a path by deleting the fallback.

## Changes, by file

1. **`modules/caddy/nixos.nix`** — rewrite. Drop the layer4
   `globalConfig`, the 8443 `httpsPort`, the `fallback` option, and the
   `mode` field. Routes become `{ hostnames, target, extraConfig? }`;
   every route renders one vhost per hostname with
   `reverse_proxy ${target}` plus optional `extraConfig` lines. Kept
   verbatim: `enable`, `acmeEmail`, the unique-hostname assertion, firewall
   80/443, and the `/var/lib/caddy` backup registration. `package` becomes
   `pkgs.caddy` — stock nixpkgs, no wrapper (see 2).

2. **`modules/caddy/package.nix`** — delete. Stock caddy needs no custom
   build and no cache marker: nixpkgs appends `https://cache.nixos.org/`
   (and its key) to every NixOS host's substituters via `mkAfter`
   (`nixos/modules/config/nix.nix` at our pin), even on the VPS, whose
   `privateCache` sets the host's own `substituters` list — the effective
   vps config, verified by eval, is private cache + `cache.nixos.org/`.
   The private B2 cache stays for custom-built app packages (photoform,
   encode_queue) only. Side effect: the recurring vendor-hash breakage
   class goes away — nixpkgs owns the caddy build and its hashes.

3. **`flake.nix`** — drop `packages.caddy-l4` (no replacement); update the
   comment that explains the `caddyfile-*` checks in terms of layer4
   syntax. The existing `caddyfile-vps` check validates the new Caddyfile
   shape, using `services.caddy.package` (now stock) as its binary; the CI
   runner fetches it from `cache.nixos.org`.

4. **`hosts/vps/default.nix`** — drop `fallback`; add the mail route:
   ```nix
   caddy.routes.mail = {
     hostnames = [ "mx1.brianjs.com" ];
     target = "https://192.168.100.41:443";
     extraConfig = ''
       transport http {
         tls_server_name mx1.brianjs.com
       }
     '';
   };
   ```
   with a comment carrying the two deliberate facts: Stalwart keeps its
   own ACME/cert (caddy is the public presenter only), and the apex is
   unclaimed by design (no A record). Also update the two stale comments
   ("Fallback-only until photoform lands"; "cannot compile caddy-with-l4
   or photoform" — caddy now arrives from `cache.nixos.org`, photoform is
   what the 1 GB limit is about).

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
ACME, its firewall ports, photoform's container, the VPS's nix
substituter setup (private B2 cache + the always-appended
cache.nixos.org), the CI workflow mechanics (the `cache = true` push loop
works unchanged; photoform and encode_queue keep the marker, so the
empty-list guard still passes).

## Rendered Caddyfile (vps, after)

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
			tls_server_name mx1.brianjs.com
		}
	}
}
```

## Risks and mitigations

- **Transient mail-443 gap at deploy**: Caddy must issue the new LE cert
  for `mx1.brianjs.com` at startup (http-01; seconds). During that window
  the name is unclaimed, so the handshake aborts with no certificate at
  all (`internal_error`) rather than mismatching. Single-user box; deploy
  at a quiet moment. IMAP/SMTPS are unaffected (bypass caddy).
- **Rollback**: `nixos-rebuild switch --rollback` on the VPS. The VPS's
  local store holds the previous generation (GC-protected by the
  `/etc/system` profile roots), so the rollback reinstalls it without
  re-fetching; `/var/lib/caddy` state is compatible.
- **Cache ordering**: caddy no longer depends on the private cache at
  all (it comes from `cache.nixos.org`), so no push-to-cache step gates
  the VPS. Still deploy after CI is green — as verification
  (`caddyfile-vps`, photoform eval) and because autoUpgrade tracks the
  verified ref.
- **Pre-existing, unchanged**: nightly autoUpgrade after a nixpkgs pin
  move pulls the new `pkgs.caddy` derivation from `cache.nixos.org`
  (built for the unstable channel), so the VPS still never compiles
  caddy.

## Verification

CI (before the VPS touches anything):

- `caddyfile-vps` runs `caddy adapt` over the new shape with the stock
  binary; the photoform eval test host still evaluates.

**Pre-deploy blockers (these gate the deploy, not the merge).** Neither
is fixable in Nix — both live in Stalwart's database — so they are
checklist items, not code:

1. **Stalwart's ACME challenge type.** In the Stalwart admin UI (or
   `stalwart-cli`), read the configured ACME challenge. If it is
   `tls-alpn-01` or `http-01`, **do not deploy**: neither has a path left
   once Caddy owns :80 and terminates :443, and the failure is silent for
   up to 90 days before it takes mail TLS on 25/465/993 down with it.
   Switch Stalwart to `dns-01` first, or accept and plan for feeding it
   Caddy's certificate instead. Also check the current cert's expiry and
   the ACME log while there — if renewals are already failing, that
   settles the open question about the l4 fallback.
2. **`use-x-forwarded`.** Turn it on in Stalwart in the same window as
   the deploy, so the gateway's IP does not become the only client IP
   Stalwart's ban logic ever sees.

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
- Unknown SNI → the handshake aborts with a TLS `internal_error` alert
  (alert 80) and *no* certificate is presented. This is the correct
  fails-closed result; do not read it as a broken deploy.
- Stalwart's own cert is still valid and its expiry has not moved
  backwards — the `tls_server_name` upstream verifies it, so `curl -sI
  https://mx1.brianjs.com/` failing with a 502 is the loud signal that
  Stalwart's ACME has stopped renewing.
- A deliberate failed webmail login shows the *real* client IP in
  Stalwart's log, not `192.168.100.40` (confirms `use-x-forwarded`).
- Real mailbox round-trip from a client (Thunderbird/phone), JMAP and IMAP.
- From the devbox: the same probes that EOF'd on the old fallback path now
  succeed. Note this as "the new path works", not as proof the old one was
  broken — see the probe caveat above; only the pre-deploy blocker check
  settles that.

## Out of scope

- haproxy/nginx `stream` alternative (considered, rejected: adds a second
  edge daemon and a duplicated SNI registry instead of removing one).
- Claiming the `brianjs.com` apex (no A record; revisit if one is ever
  added).
- Turning off Stalwart's ACME (explicitly kept on) — but see the
  pre-deploy blockers: keeping it on requires it to have a working
  challenge, which this change removes for everything but dns-01.
- Any Nix-level Stalwart, photoform, DNS, or firewall-topology change
  beyond the comments listed above. The two Stalwart settings in the
  pre-deploy blockers are database-managed and deliberately not
  automated here.
