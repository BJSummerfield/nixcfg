# Revert to the caddy-l4 SNI edge

Restore the layer4 SNI edge so Stalwart terminates its own TLS on :443 again
and its ACME renewal works without any certificate plumbing. Undo PR #143
entirely, and undo PR #140's move to a terminating stock-caddy edge — but
keep the one lesson #140's deploy taught, by closing unclaimed connections
instead of funneling them into Stalwart.

## Problem

PR #140 made stock caddy the sole TLS authority on :443, terminating for
every claimed hostname and reverse-proxying to the service behind it. That
works for `booking.summerfieldphotography.com`. It does not work for
`mx1.brianjs.com`, because Stalwart's certificate does not only serve
webmail — it serves SMTP on 25, submissions on 465, and IMAP on 993, all of
which bypass caddy entirely.

Stalwart 0.15.5 can obtain that certificate two ways, and both are closed:

- **TLS-ALPN-01** needs exclusive use of :443 for `mx1.brianjs.com`. Caddy
  holds it.
- **DNS-01** supports only Cloudflare, TSIG, and SIG0 providers. DNS is at
  Namecheap, whose API is gated behind account minimums.

So since #140 deployed, Stalwart has had no renewal path. Its current
certificate is valid to 2026-11-03 with renewal due 2026-10-04; after that,
mail TLS breaks silently on ports no browser will ever tell you about.

PR #143 attempted to close this by having caddy publish its own
`mx1.brianjs.com` certificate to disk for Stalwart to read. Implementing it
surfaced two further obstacles:

1. `%{file:...}%` macro expansion does not happen for database-stored
   settings, so the certificate could not be pointed at the published files
   through the admin UI. (Almost certainly deliberate on Stalwart's part —
   otherwise admin UI access would read arbitrary host files.)
2. Caddy issues SEC1-encoded EC private keys. Stalwart 0.15.5 parses only
   RSA (PKCS#1) and PKCS#8: `Error parsing TLS private key - no RSA or
   PKCS8-encoded keys found`, confirmed against the deployed binary.

Each has a fix, and together they amount to a permanent, bespoke certificate
pipeline — a registry, a publish unit, a path watcher, a backstop timer, a
shared gid, a bind mount, an API key, a reload hook, and a key transcode —
to work around a port conflict this host does not need to have.

## Decision: go back to layer4 passthrough, without the fallback

The layer4 edge routes on ClientHello SNI *before* forwarding any bytes. A
`tcp` route hands the connection to Stalwart untouched, so Stalwart
terminates its own TLS and TLS-ALPN-01 works exactly as it did before #140.
Nothing publishes, converts, or reloads a certificate. PR #143 is deleted
rather than fixed.

**The fallback does not come back.** Pre-#140, Stalwart was not a route at
all — `hosts/vps/default.nix` set `fallback = "192.168.100.41:443"`, so every
connection no route claimed (unknown SNI, absent SNI, non-TLS, every internet
scanner) was proxied raw into Stalwart from the veth gateway. That is what
got `192.168.100.40` auto-banned immediately after the #140 deploy, which in
turn 502'd webmail. Stalwart instead becomes an explicit `tcp` route claiming
`mx1.brianjs.com`, and unclaimed connections are closed at the edge.

The `fallback` option is removed from the module rather than merely left
unset. Nothing uses it, its only historical use is the behaviour being
designed out, and an option whose sole effect is to expose a backend to
unauthenticated internet noise is a footgun worth deleting. Re-add it if a
real consumer ever appears.

### Alternatives rejected

- **Finish #143** (certificate in Nix local config, PKCS#8 conversion in the
  publish script). Technically sound and mostly written, but leaves this repo
  permanently owning a certificate pipeline to work around a self-inflicted
  port conflict.
- **Move DNS to Cloudflare** so Stalwart's native DNS-01 provider works. This
  deletes the coupling outright and is the best long-term answer, but it
  requires migrating MX, SPF, DKIM, and DMARC records for a live mail domain.
  Deferred, not dismissed.
- **NixOS `security.acme` as a single host issuer.** Replaces bespoke code
  with nixpkgs code but keeps the same architecture — still injecting certs
  into the container, still needing a reload hook.
- **Move photoform to its own VPS**, freeing :443 entirely so caddy leaves
  this box. This is the intended end state and makes the edge unnecessary
  rather than correct. Out of scope here; this change is what keeps mail
  working until then.

## Behavior after this change

| Connection | Path |
|---|---|
| `mx1.brianjs.com:443` (webmail, ACME TLS-ALPN-01) | layer4 matches `@mail`, proxies raw to `192.168.100.41:443`; Stalwart terminates |
| `booking.summerfieldphotography.com:443` | layer4 matches `@photoform`, proxies to caddy's HTTPS server on `127.0.0.1:8443`; caddy terminates and reverse-proxies to `192.168.100.51:8080` |
| Unknown SNI, no SNI, non-TLS on :443 | No route matches and there is no fallback — connection closed at the edge |
| :80 | Caddy's HTTP-01 lane, for the certificates caddy still issues |
| 25 / 465 / 993 | Unchanged: DNAT straight to the container, Stalwart's own certificate |

Caddy stops issuing for `mx1.brianjs.com` — it never terminates that name
again. Stalwart becomes the sole issuer for it, as it was before #140, which
also ends the two-Let's-Encrypt-accounts-for-one-name arrangement that
`hosts/vps/default.nix` currently documents.

## Rendered Caddyfile (vps, after)

Global:

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

Virtual hosts — `tls` routes only, so `mx1.brianjs.com` is absent:

```
booking.summerfieldphotography.com {
  reverse_proxy 192.168.100.51:8080
}
```

## Changes, by file

**`modules/caddy/package.nix`** — restore from `bd38b3f`. The nixpkgs pin has
not moved since it was deleted (`9fbb54b33e91ee4ca368e35a78e0613c720600b3`
then and now), so the plugin vendor hash
`sha256-C+ksbA6ucY3GUsYHSUhkYoh1gTP8SIAJv0MLjhX8BQM=` is still valid and this
is a byte-identical restore. Keeps `passthru.cache = true` so the 1 GB VPS
substitutes the build instead of compiling it.

**`modules/caddy/nixos.nix`** — restore the layer4 version from `bd38b3f`,
with two deliberate differences from that file:

- **Add** #140's assertion that a route claims at least one hostname.
  `genAttrs` over an empty list yields no vhost, so such a route would
  silently claim nothing rather than fail. Worth carrying forward.
- **Drop** the `fallback` option and the fallback branch of `layer4Server`,
  per the decision above.

Two things current `main` has are simply not carried forward, which the
restore accomplishes by itself: `extraConfig` (added in #140 to tune the
upstream transport for a TLS upstream — the only one was `mx1`, now
passthrough), and the whole `certExports` registry from #143 (option,
assertion, `certDirFor`, `claimedHostnames`, and the generated
`systemd.services` / `systemd.paths` / `systemd.timers` / `users.groups`).

**`modules/stalwart-server/nixos.nix`** — delete everything #143 added:
`apiKeyFile`, the `certDir` / `mailHostname` / `certGid` bindings, the
`mine.system.caddy.certExports` registration, the `certDir` bind mount, the
`users.groups.stalwart-certs` declarations on both host and container, the
`stalwart-mail` group membership, and the `certDir` lines in
`system.activationScripts.stalwart-dirs`. Then add, guarded on the caddy
module's enable exactly as photoform does:

```nix
mine.system.caddy = lib.mkIf config.mine.system.caddy.enable {
  routes.mail = {
    hostnames = [ "mx1.brianjs.com" ];
    mode = "tcp";
    target = "192.168.100.41:443";
  };
};
```

This is the one genuinely new thing versus pre-#140, and it is what makes
`fallback = null` possible: the mail path is explicit and module-owned rather
than being whatever the edge failed to match. The firewall and NAT blocks are
unchanged — the edge still owns :443, so the conditional 443 DNAT stays off
when caddy is enabled — but their comments need rewording from "caddy
terminates TLS, then reverse-proxies it over TLS" to describe passthrough.

**`modules/photoform/nixos.nix`** — restore `mode = "tls"` on the route.

**`hosts/vps/default.nix`** — remove `sops.secrets.stalwart-api-key` and the
`apiKeyFile` line. Remove `routes.mail` from the caddy block, which the
stalwart module now owns; the block reduces to `enable` and `acmeEmail`.
Restore the `privateCache` comment's reference to caddy-l4 needing to arrive
as a substituted closure. Replace the long comment about caddy being the sole
TLS authority and two LE accounts, which stops being true.

**`flake.nix`** — restore `caddy-l4 = pkgs.callPackage ./modules/caddy/package.nix { };`
to `packages`, which also restores its `pkg-caddy-l4` CI check. Remove the
`stalwart` check. Restore "layer4" in the caddyfile-check comment. The
`caddyfile-<host>` checks need no other change: they already use
`cfg.config.services.caddy.package`, so they pick up the l4 binary
automatically — which matters, because a stock caddy adapter would reject
`layer4` as an unknown directive.

**`tests/photoform.nix`** — restore the `mode == "tls"` assertion. Replace
the "the edge runs the stock caddy package" check with one asserting the l4
build. Do not restore `fallback` to the test host's config; the option no
longer exists.

**`tests/stalwart.nix`** — delete.

**`secrets/hosts/vps.yaml`** — remove the `stalwart-api-key` entry.

## Operator cleanup

Ordered so that nothing is removed before it stops being load-bearing.
`letsencrypt-1` is never touched — it stayed enabled throughout #143, its
certificate is valid to 2026-11-03, and it resumes renewing the moment :443 is
passthrough again.

Before deploying, in the admin UI:

1. Delete the `certmanager` API key. Nothing reads it after this change.
2. Delete the `mx1` TLS certificate record under Server → TLS → Certificates,
   if it still exists. It never worked, and leaving it would fight Stalwart's
   ACME-obtained certificate.
3. Turn **`use-x-forwarded` off** (Obtain remote IP from Forwarded header).
   This was enabled for the #140 arrangement where caddy terminated and set
   the header. Under layer4 passthrough nothing sets it, so leaving it on
   means trusting a header no trusted proxy is writing.

After deploying:

4. `sudo rm -rf /var/lib/stalwart-certs`
5. `sudo groupdel stalwart-certs` — NixOS does not remove groups when their
   declaration disappears.
6. Remove `stalwart-api-key` from `secrets/hosts/vps.yaml`. Requires an age
   identity, so this is an operator step.

## Risks and mitigations

**Plugin vendor-hash fragility.** `caddy.withPlugins` embeds a hash of the
vendoring step's output, which depends on nixpkgs' default Go toolchain. A Go
bump alone invalidated it on 2026-08-28 with caddy untouched, and that
fragility was the stated reason for #140. Accepted knowingly. The mitigation
is structural and already in place: `pkg-caddy-l4` is a CI check, so a bad
hash fails CI, the `verified` ref does not advance, and hosts stay on their
last good build. The cost is manual hash updates on some nixpkgs bumps.

**Webmail client IPs collapse to the gateway.** Layer4 passthrough carries no
client address, so every webmail connection appears to Stalwart as
`192.168.100.40`. Concentrated authentication failures could re-trigger the
auto-ban. Much smaller than before, because `fallback = null` means only
genuine `mx1` SNI reaches Stalwart at all rather than the whole internet's
scan traffic. If it recurs, the fix is to allow-list the gateway in Stalwart's
security settings, and note that clearing a `BlockedIp` entry requires
`systemctl restart container@stalwart` to take effect.

**Deploy briefly interrupts webmail, not mail.** The container is not
restarted by this change, but caddy is, and `mx1` reachability moves from a
terminating vhost to a passthrough route. Ports 25/465/993 are untouched DNAT
and are unaffected throughout.

**Rollback.** `sudo nixos-rebuild switch --rollback`. Nothing in this change
is database-managed, so unlike #143 the rollback is complete — with one
exception: the three admin-UI cleanup steps above are DB state and would have
to be undone by hand. None of them is load-bearing for the previous
configuration except `use-x-forwarded`, which only matters if rolling back to
the terminating edge.

## Verification

Eval and CI, before any deploy:

- `nix flake check` passes, including `pkg-caddy-l4` (a real build, so a stale
  vendor hash fails here) and `caddyfile-vps` (the l4 binary's own adapter over
  the rendered config, so a layer4 syntax error fails here).
- `tests/photoform.nix` passes with the restored `mode` assertion.

On the box, after deploy:

1. **Webmail** — `curl -v https://mx1.brianjs.com/` presents Stalwart's
   certificate directly, not one caddy issued.
2. **Booking site** — `curl -v https://booking.summerfieldphotography.com/`
   still works and presents caddy's certificate.
3. **Unclaimed SNI is closed, not forwarded** — the edge case this design
   exists to fix. Connect with an unrelated SNI and with no SNI, and confirm
   both fail at the edge rather than reaching Stalwart. Cross-check that
   Stalwart's log shows no corresponding connection.
4. **Mail ports** — send and fetch over 993 and 465 from a real client, and
   confirm the certificate presented is Stalwart's.
5. **ACME is alive again** — Stalwart's startup log shows
   `Processing ACME certificate ... id = "letsencrypt-1"` with a `due` date,
   and no TLS-ALPN errors follow. This is the whole point of the change, so it
   is worth forcing a renewal rather than waiting for 2026-10-04.
6. **Blocked-IP list stays clean** — check that `192.168.100.40` has not been
   re-banned after normal webmail use.

## Out of scope

- The `brianjs.com` apex, which has no A record and is unclaimed by design.
- Adding mail domains. Stalwart hosts additional domains on the same MX
  hostname; that is a DB and DNS operation and needs no certificate work.
  A second *hostname* clients connect to would need new plumbing, and is not
  planned.
- Moving photoform to its own VPS, and the DNS-to-Cloudflare migration. Both
  are better end states than this change; both are deferred.
