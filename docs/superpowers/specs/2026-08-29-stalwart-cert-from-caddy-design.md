# Stalwart Consumes Caddy's Certificate — Design

> **Superseded:** this design describes an architecture that `plan/revert-to-caddy-l4` deletes and that cannot work (see `docs/superpowers/specs/2026-08-29-revert-to-caddy-l4-design.md`). Not implementable as written; kept for history only.

**Status:** approved 2026-08-29, pending implementation plan.

## Problem

The stock-caddy edge (PR #140, deployed 2026-08-29) made caddy the sole TLS
authority on ports 80 and 443. Stalwart's ACME challenge is **TLS-ALPN-01**,
which answers the :443 handshake — a handshake caddy now terminates. Stalwart
can therefore no longer renew its certificate.

This is not a webmail problem. Webmail reaches Stalwart through caddy and works.
The certificate matters because **SMTP 25, submissions 465, and IMAPS 993 bypass
caddy entirely** and present that same certificate directly to mail clients,
which validate it against public roots. So Stalwart still needs a publicly-valid
certificate on ports caddy is not in the path for, and has lost every lane it
had to obtain one:

- **TLS-ALPN-01** needs to answer the :443 handshake — caddy owns it.
- **HTTP-01** needs `/.well-known/acme-challenge/` on :80 — caddy owns it, and
  needs that same path for the same hostname for its own renewals.
- **DNS-01** is supported, but Stalwart 0.15.5 ships only Cloudflare, TSIG and
  SIG0 providers. DNS for `brianjs.com` is at Namecheap. DNS-PERSIST-01, which
  would allow one static TXT record and no API, does not exist in 0.15.5.

The failure is silent. Nothing breaks at the moment renewal stops; the current
certificate keeps working until it expires, and then mail TLS fails for every
client at once.

## Approach

Caddy already obtains and renews `mx1.brianjs.com` over HTTP-01, automatically,
and has since the edge deployed — verified by an unflagged `curl -sI
https://mx1.brianjs.com/` completing its handshake against public roots. The
acquisition problem is already solved; it is solved in the wrong process.

So: **caddy keeps obtaining and renewing the certificate; Stalwart stops doing
ACME and consumes the result.** Stalwart's own ACME provider is disabled, and its
TLS configuration points at PEM files on disk.

### Why not bind-mount caddy's storage

Caddy stores the certificate at:

```
/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mx1.brianjs.com/mx1.brianjs.com.crt
                                                                                                     mx1.brianjs.com.key
```

That path embeds both caddy's internal storage layout and the ACME directory
URL. Mounting it directly would couple the stalwart container to a caddy
implementation detail and break on a CA change. A publish step copies to a
stable location instead.

### The load-bearing constraint

**Stalwart does not reload certificates from disk when they change.** It reads
them at config load and serves from memory. A bind mount alone therefore
produces a certificate that works for roughly 60 days and then goes stale at the
first renewal — reintroducing exactly the silent-expiry failure this design
exists to remove.

The renewal hook is the essential component, not the mount.

Stalwart 0.15.5 exposes a graceful reload over its management API:

```
GET /api/reload/certificate    Authorization: Bearer <api-key>
```

requiring an API key with the "Refresh system settings" permission. (Stalwart
0.16+ replaces this with a `ReloadTlsCertificates` JMAP action and is retiring
`stalwart-cli`; the curl form is both what 0.15.5 has and the shape with a
future.)

## Architecture

### 1. `mine.system.caddy.certExports` — a registry on the edge

A new registry in `modules/caddy/nixos.nix`, mirroring the existing `routes`
registry: service modules register into the edge guarded on its `enable`, so
registrations stay inert on hosts without one.

```
certExports.<name> = {
  hostname   = str;   # a name some route claims
  destination = path; # stable directory to publish into
  owner      = str;
  group      = str;
  postPublish = lines; # command run after a successful copy
};
```

Caddy owns all knowledge of its storage layout; consumers never encounter the
`acme-v02.api.letsencrypt.org-directory` path segment.

**Assertion:** an export's `hostname` must be claimed by some route. Caddy only
obtains certificates for names it serves, so an unclaimed hostname would publish
nothing, silently.

### 2. Publish and reload

A `systemd.path` watches caddy's certificate directory for the exported
hostname. On change, a oneshot service:

1. copies `.crt` and `.key` into `destination` with the configured ownership,
2. runs `postPublish`,
3. verifies the result (below).

A daily timer backstops the watch. This follows the precedent set by
`systemd.timers.devbox-warm` in `modules/devbox/container.nix`: a missed inotify
event is cheap to guard against and expensive to suffer.

`modules/stalwart-server/nixos.nix` registers the export, bind-mounts
`destination` read-only into the container alongside the existing mounts, and
supplies `postPublish`:

```
nixos-container run stalwart -- curl --fail \
  -H "Authorization: Bearer $(cat <api-key-path>)" \
  http://127.0.0.1:8080/api/reload/certificate
```

Run **inside** the container against the management listener, so no TLS is
involved in rotating TLS — avoiding the chicken-and-egg of validating a
connection secured by the certificate being replaced.

If the reload call does not succeed, the fallback restarts Stalwart. A restart
costs a few seconds of dropped mail connections; a stale certificate costs 90
days of broken mail TLS.

### 3. Verification

After reload, compare the SHA-256 fingerprint of the certificate Stalwart
actually serves on `192.168.100.41:443` against the file just published. A
mismatch means the reload silently did not take, and the unit exits non-zero.

**Ownership boundary.** The reload call, its restart fallback, and this
verification are all Stalwart-specific and live in the stalwart module's
`postPublish`. The caddy registry stays generic: it knows how to find a
certificate and copy it somewhere with an owner, and it runs a command
afterwards. It knows nothing about Stalwart, management APIs, or containers. A
future consumer supplies its own `postPublish` and needs no change to the edge.

**Known gap, stated rather than papered over:** a failed systemd unit is only a
signal if something watches it, and this repo has no alerting infrastructure.
The realistic guarantee is "visible in `systemctl --failed`, re-asserted daily
by the backstop timer" — strictly better than today's total silence, short of a
page. Closing it properly is out of scope here.

### 4. Secrets

`sops.secrets.stalwart-api-key` declared in `hosts/vps/default.nix` against
`secrets/hosts/vps.yaml`, consumed through a module option in the same style as
the existing `adminPasswordFile`.

## Operator steps (not code)

Both are DB-managed in Stalwart's admin UI and cannot be expressed in Nix:

1. Create an API key with the "Refresh system settings" permission; store it in
   `secrets/hosts/vps.yaml`.
2. Point Stalwart's TLS configuration at the published PEM files and **disable
   its ACME provider**, so it stops attempting TLS-ALPN-01.

## Testing

Eval tests following `tests/photoform.nix`:

- the export registers against the edge with the expected hostname and
  destination,
- the container bind-mounts the destination read-only,
- the assertion rejects an export whose hostname no route claims.

Post-deploy verification is operator-run: confirm the certificate Stalwart
serves on 25/465/993 is the one caddy issued, and force a republish to confirm
the reload path works end to end rather than waiting 60 days to find out.

## Out of scope

The `brianjs.com` apex (no A record, unclaimed by design), the mail-port
forwards, photoform, caddy's own ACME configuration, and the alerting gap noted
above. The certificate swap is the whole scope.

## Context

Two of the edge migration's pre-deploy blockers materialised on 2026-08-29:

- Stalwart had auto-banned `192.168.100.40`, the veth gateway and caddy's source
  IP, so every webmail request returned 502. Deleting the `BlockedIp` entry was
  not sufficient — it required `systemctl restart container@stalwart`. Resolved
  the same day. The likely original trigger was the old caddy-l4 fallback
  funnelling internet scan traffic into Stalwart from the gateway address; the
  stock-caddy edge removes that funnel, since unknown SNI now fails closed at
  caddy and never reaches Stalwart.
- `use-x-forwarded` ("Obtain remote IP from Forwarded header") is now enabled. It
  must stay paired with caddy being the only reachable path to the HTTP
  listener.

This design addresses the third and last outstanding blocker.
