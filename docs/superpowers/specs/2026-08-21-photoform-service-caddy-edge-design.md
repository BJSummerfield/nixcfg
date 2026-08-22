# PhotoForm service + Caddy edge: booking site and mail server on one 443

## Problem

vps must serve `booking.arisummerfieldphotography.com` (the PhotoForm booking
webapp, sub-project B of the binary-cache work) while Stalwart continues to
own mail. Today all of 443 is DNAT'd straight into the Stalwart container
(`modules/stalwart-server/nixos.nix` forwards 25/465/993/443 to
`192.168.100.41`), and Stalwart terminates its own TLS with ACME state managed
in its database. Two services now need the same port on the same IP,
distinguishable only by SNI — and one of them is a live mail server whose
certificate machinery must not be disturbed.

Separately, the repo has no reverse-proxy story at all: immich, vikunja and
jellyfin are tailscale-only. Whatever solves vps's 443 should be a module any
host can adopt, not a vps one-off.

## Goal

The booking site is publicly served with automatic certificates; every mail
path behaves byte-for-byte as it does today; the edge module is generic and
registry-driven so future services (and future hosts) add routes with one
guarded attrset; and PhotoForm itself arrives on vps exclusively through the
private binary cache — vps never compiles it.

## Decisions

- **SNI passthrough now (A); single-TLS-authority later (B), designed-for but
  not built.** Caddy's `layer4` app owns host 443, matches the ClientHello
  SNI, and routes: known web hostnames are handed to Caddy's own HTTPS server
  (terminate + reverse_proxy); everything else — unknown SNI, no SNI —
  passes through encrypted to Stalwart's 443 untouched. Stalwart keeps doing
  its own ACME because it needs certificates for 465/993/25 regardless; Caddy
  cannot front those ports, so moving web TLS into Caddy would not free
  Stalwart from holding certs — it would only change where they come from.
  Architecture B (Caddy terminates everything, Stalwart's web goes plain-HTTP
  behind the proxy, mail-port certs are shared Caddy→container with renewal
  reloads) is the deliberate future consolidation: it removes the l4 plugin
  and the second ACME stack, at the price of surgery on a live mail server's
  DB-managed cert config. The migration path A→B is additive — a Stalwart
  route flips from passthrough to `tls` mode — which is why A ships first.

- **The edge is a generic host module, `mine.system.caddy`.** Registry style,
  same shape as `mine.backups`: service modules register routes guarded on
  `config.mine.system.caddy.enable`, so registrations are inert on hosts
  without an edge. Hostname *lists* are the primary key — one service may
  claim many names (the apex joins photoform's list when the repo grows into
  the main site), and future arisummerfield mail hostnames can route to
  Stalwart without structural change.

- **Fail-open toward mail.** vps sets `fallback` to the Stalwart container's
  443. Any SNI the registry does not claim degrades to exactly today's DNAT
  behaviour, including SNI-less legacy clients. The failure geometry is
  deliberate: a registry mistake breaks the booking site, never mail.

- **Stalwart's 443 forward becomes conditional.** The Stalwart module drops
  its 443 `forwardPorts` entry when the host enables caddy (which then owns
  the socket) and keeps it otherwise. The mail-port forwards (25/465/993) are
  unconditional. Caddy also takes the currently-unused port 80 for HTTP-01
  challenges, keeping its ACME entirely out of Stalwart's lane.

- **`caddy.withPlugins` with `caddy-l4`.** The layer4 app is out-of-tree;
  `pkgs.caddy.withPlugins` (present in the pinned nixpkgs) builds it in at the
  cost of one pinned hash — the same maintenance shape as a cargoHash. The
  plugin-free alternative (nginx `stream` + `ssl_preread`) was considered and
  rejected: it either makes the HTTP layer nginx too or runs two daemons, and
  Caddy's automatic ACME is the point of choosing it for a growing site.

- **PhotoForm's secrets move to environment variables; its content moves to
  version control.** Upstream repo change (prerequisites below): the four
  secrets leave `config.toml` entirely (deleted, not optional-with-override),
  the Google service-account JSON path becomes env-overridable, and the
  de-secreted `production.toml` is committed and installed into
  `$out/share/photoform/`. The NixOS module then knows nothing about
  photography content: it delivers five env values and a config path.

- **Per-event operating model.** A new shoot is a photoform-repo commit plus
  a `rev` + `sha256` bump in nixcfg (content-only changes leave `cargoHash`
  untouched); CI builds, signs, pushes to the cache, `verified` advances, vps
  pulls. Called out explicitly: every content change passes through a full
  CI build. At a few shoots a year that is the right trade for keeping app
  content with the app; it would not be at weekly cadence.

- **Mail sending stays Gmail.** The app's SMTP is the business's Gmail app
  password. This design does not route contract email through Stalwart;
  attaching arisummerfield mail domains to Stalwart is future work, unrelated
  to shipping the booking form.

- **Ordering rule: the container may not land until vps demonstrably
  substitutes photoform from the cache** (binary-cache plan Task 9). There is
  no state in which vps tries to compile the app.

- **Backups use the proven stop-strategy.** The container's sqlite registers
  with `mine.backups.paths` and `stopContainers`; the form is briefly down at
  04:00 like every other stateful service here.

## Scope

**In:**

- `modules/caddy/nixos.nix` — new generic edge module
- `modules/photoform/nixos.nix` — new service module + nspawn container
- `modules/stalwart-server/nixos.nix` — conditional 443 forward
- `hosts/vps/default.nix` — enable caddy (fallback to Stalwart), enable
  photoform, five new sops secrets
- `secrets/hosts/vps.yaml` — PayPal id/secret, SMTP password, admin password,
  sheets service-account JSON
- Upstream `Sheet-Automation-FF` changes (prerequisites below)
- DNS: `booking.arisummerfieldphotography.com` A record → vps

**Out:**

- Architecture B (Caddy as sole TLS authority, cert sharing into Stalwart)
- The apex/main site, and any arisummerfield mail domains
- Routes for immich/vikunja/jellyfin on other hosts (the module supports it;
  nobody wires it yet)
- Any change to the binary-cache pipeline (sub-project A, complete)

## App-repo prerequisites (the definition of "photoform is ready")

1. Secrets read from env: `PHOTOFORM_PAYPAL_CLIENT_ID`,
   `PHOTOFORM_PAYPAL_CLIENT_SECRET`, `PHOTOFORM_SMTP_PASSWORD`,
   `PHOTOFORM_ADMIN_PASSWORD`; the corresponding TOML fields deleted.
2. `PHOTOFORM_SHEETS_CREDENTIALS_FILE` overrides
   `sheets.service_account_json_path`.
3. `config/production.toml` committed (real event content, no secrets),
   installed by the build to `$out/share/photoform/production.toml`.
4. Real event/rain dates and the four-vs-five images contradiction in
   `contract.md` resolved (flagged in the repo's own comments).
5. `--config <path>` selects the config file. The app reads only
   `BOOKING_CONFIG` today; the NixOS unit passes `--config`.
6. The deployment contract is written down *in the app repo* — which env
   vars, which file, why the TOML fields are gone. Nothing in that repo
   currently mentions it, so the next person to open `config.example.toml`
   has no way to know a second consumer exists.

## Approach

### The edge module

Options: `enable`, `acmeEmail`, `fallback : nullOr str`, and
`routes : attrsOf { hostnames : listOf str; mode : enum "tls" "tcp";
target : str }`. Rendering: one layer4 listener on 443 — for every route, an
SNI matcher over its hostnames; `tls` routes hand off to Caddy's HTTPS
server, which gets a vhost per hostname (automatic ACME, `reverse_proxy` to
the target); `tcp` routes and the fallback are raw proxies. Port 80 serves
HTTP-01. Enabling opens 80/443 in the firewall. The l4 plugin pin lives here.

### The photoform module

nspawn container at `192.168.100.51` (next free slot), pattern copied from
immich/dns. Inside: a hardened systemd service, its own user, running the
cached package with `--config $pkg/share/photoform/production.toml`. Secrets:
an env-format `sops.templates` file rendered on the host — four secret
placeholders plus `PHOTOFORM_SHEETS_CREDENTIALS_FILE` as a literal path — and
bind-mounted in, plus the service-account JSON as its own secret. The
module registers `caddy.routes.photoform = { hostnames =
[ "booking.arisummerfieldphotography.com" ]; mode = "tls"; target =
"192.168.100.51:8080"; }` guarded on the host's caddy enable, and registers
its sqlite directory with `mine.backups` guarded the same way backups always
are.

### Rollout — mail-first, three independently verifiable steps

1. Land caddy with **only the fallback** on vps. Deploy. Verify every mail
   path through the passthrough: webadmin via tailscale, JMAP, IMAPS, SMTPS,
   inbound 25, and that Stalwart cert renewal still works (its ACME flows
   through the fallback).
2. Land the photoform container + route; point booking DNS at vps; watch
   Caddy obtain the certificate. (Gated on Task 9 green.)
3. End-to-end booking test: form → PayPal sandbox → sheet row → email.

## Failure modes

- **Caddy down.** 443 is down for both the booking site and Stalwart's web
  endpoints; mail delivery (25) and client access (465/993) are unaffected.
  Today only a kernel NAT rule sits in that path; this is the real new risk
  and the reason step 1 of the rollout stands alone.
- **Registry mistake / unknown SNI.** Falls through to Stalwart — today's
  behaviour. Breaks toward the booking site, never toward mail.
- **Stalwart loses the client IP on 443.** The one place "byte-for-byte as
  today" is not literally true: DNAT rewrote only the destination, so
  Stalwart saw real client addresses, while a userspace proxy dials from
  the host. Web, JMAP and webadmin now all arrive from `192.168.100.40`;
  25/465/993 keep their real addresses. The sharp edge is per-IP
  auto-banning — a brute-force sweep against public 443 can ban the host
  address and take out every web path through the edge at once. The
  alternative is PROXY protocol (the handler is in the pinned binary) and
  a matching listener change in Stalwart's DB-managed config, which
  architecture A deliberately does not touch.
- **ACME failure for booking.** Site unreachable until resolved; mail
  untouched. Caddy retries; port 80 is its own lane.
- **l4 plugin hash rot.** A caddy bump in nixpkgs invalidates the plugin
  pin; CI catches it as a build failure, hosts stay on their last good build.
- **Backup consistency.** The 04:00 stop closes sqlite cleanly before restic
  reads it — same argument as every other stopContainers service.

## Verification

- Step-1 deploy: `openssl s_client -connect vps:443 -servername <stalwart
  hostname>` returns Stalwart's certificate; with `-servername
  booking.arisummerfieldphotography.com` (pre-step-2) falls back to Stalwart
  likewise; mail client checks pass.
- Step-2: the same probe with the booking SNI returns a Caddy-issued LE
  certificate; `curl https://booking.arisummerfieldphotography.com` returns
  the form; `nixos-rebuild` on vps shows photoform *fetched* from
  `s3://spacefunk-nix-cache`, never built.
- The five other hosts' toplevel drvPaths are unchanged by the caddy module's
  existence (it is enable-gated everywhere).

## Success criteria

- Booking site live with a valid certificate; a full test booking completes.
- Every mail protocol works identically to pre-caddy, verified not assumed.
- vps has never compiled photoform; the closure came from the cache.
- Adding a future web service to any host is: one route attrset in its
  module, one `caddy.enable` on its host.
- Architecture B remains a documented flip, not a rewrite.
