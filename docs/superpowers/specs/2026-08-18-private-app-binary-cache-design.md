# Private app: build in CI, cache in B2, substitute on vps

`<app>` throughout stands for the package/attribute name of the private
webserver. It is the only free parameter; nothing in this design depends on
the choice.

## Problem

A private GitHub repo holds a Rust webserver that will run on vps. Packaging
it the way `modules/encode_queue/package.nix` packages a public repo does not
work: fetching private source needs a credential, and every obvious way of
supplying one puts a GitHub token on machines that should not have it.

Two properties of this repo constrain the answer:

- **Hosts evaluate the flake themselves.** `modules/system/nixos.nix:94` points
  `system.autoUpgrade` at `github:BJSummerfield/nixcfg/verified`, run by root,
  non-interactively, at 04:00. elitebook, paynefield and vps do this.
- **nixcfg is public.** No credential can live in-tree unencrypted, and CI runs
  on a public repo's Actions.

Separately, vps is a ~1 GB VM already running Stalwart (`hosts/vps/default.nix`
notes the box has ~1 G and uses zram rather than swap for exactly this reason).
`builders` is empty in its nix.conf, so it builds its own closure. Compiling a
Rust webserver there during an unattended 04:00 upgrade risks the OOM killer
taking Stalwart with it.

## Goal

vps runs the private app without ever fetching its source, without compiling
it, and without holding a GitHub credential. Pull-based `autoUpgrade` is
unchanged.

## Decisions

- **`fetchFromGitHub { private = true; }`, not a flake input.** A fixed-output
  derivation's store path is computed from its declared `sha256`, so
  *evaluation needs only the hash, never the source*. Hosts can evaluate the
  whole flake with no credential; the source is fetched only when the
  derivation is actually realised. A flake input has the opposite property —
  it is fetched at eval time on every evaluator, so every host would need a
  token. This single property is why the less-common route is the right one
  here, and it follows directly from keeping hosts as evaluators.

- **nixcfg's CI builds the app, not the private repo's CI.** For vps to
  substitute rather than build, the store path it computes must be identical
  to the one CI pushed. Store paths hash the whole derivation graph, including
  the nixpkgs revision. Only nixcfg's CI has nixcfg's `flake.lock`. A separate
  flake in the app repo with its own nixpkgs pin would push paths vps never
  asks for, and the cache would silently do nothing while vps compiled anyway.

- **The private repo stays pure source.** No flake in it. Packaging lives in
  nixcfg exactly as encode_queue's does. A consequence worth naming: bumping
  nixpkgs in nixcfg rebuilds and re-pushes the app automatically, so the cache
  cannot drift out of sync with what hosts want.

- **A fine-grained PAT is sufficient.** Fine-grained tokens were once broken
  with `fetchFromGitHub` (nixpkgs#321481: 404s despite correct permissions).
  The fix switched private fetches to the `api.github.com` tarball endpoint,
  and that code is present in the pinned nixpkgs — `fetchgithub/default.nix`
  carries the comment "Use the API endpoint for private repos, as the archive
  URI doesn't support access with GitHub's fine-grained access tokens."
  Documentation predating the fix recommends classic tokens; ignore it.

- **A new, dedicated B2 bucket.** The prune step is a bulk-delete script and
  must not be able to reach restic data. `modules/backups/nixos.nix` states the
  principle already: "no container ever sees the B2 credentials — a compromised
  service cannot read, delete or poison its own backups." restic also speaks
  B2's native API (`B2_ACCOUNT_ID`/`B2_ACCOUNT_KEY`) while nix speaks its
  S3-compatible one (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).

- **Private bucket, read-only key on vps.** A public bucket would need no
  credential at all, but the compiled binary would be fetchable by anyone who
  learned the store path. A bucket-scoped read-only B2 key is a much weaker
  credential than a GitHub PAT: it cannot read source, cannot write, and is
  trivially rotated.

- **Plain S3. No attic, no niks3.** attic self-describes as "an early
  prototype", needs a server plus a database, cannot fit on vps at 1 GB, and its
  headline feature is global deduplication across many caches — a multi-tenant
  problem that does not exist here. niks3 is production-grade but needs
  PostgreSQL and a server reachable from GitHub's runners. Both solve
  reference-tracked GC for many closures and many writers. There is one closure
  and one writer.

- **GC is a CI step, not a service.** CI already holds the write key and
  already knows which paths are current. Reference-based pruning is therefore
  ~15 lines. Time-based expiry is specifically unsafe: `nix copy` skips paths
  already present, so an object's timestamp never refreshes, and a 90-day rule
  would eventually delete a NAR still in active use — causing the exact 1 GB
  Rust compile this design exists to prevent.

- **Retention is keep-2, not keep-1.** Keeping the previous closure alongside
  the current one closes the window where `verified` has just advanced while
  vps is mid-upgrade. Costs roughly one closure — encode_queue's runtime
  closure is 47 MiB, and this app is comparable.

- **Push and prune are guarded to `push` on `main`.** `check.yml` runs on
  `pull_request` too. A PR bumping the app's `rev` builds a different closure;
  if it also pruned, it would delete the closure `verified` still points at.
  The existing `Advance verified` step already carries the right guard
  (`if: github.event_name == 'push'`).

- **`cargoLock.lockFile` rather than `cargoHash`.** We own the repo, so the
  lock file is in the fetched source. A release bump then edits `rev` and
  `sha256` instead of three values. Requires crates.io-only dependencies; git
  dependencies would need `outputHashes`.

## Scope

**In:**

- `modules/<app>/package.nix` — new, private `fetchFromGitHub`
- `flake.nix` — add `<app>` to `packages`; `checks` picks up `pkg-<app>`
  automatically via the existing `mapAttrs'` at `flake.nix:122`
- `modules/system/nixos.nix` — new `mine.system.privateCache` option
- `hosts/vps/default.nix` — sops secret + enable the option
- `secrets/hosts/vps.yaml` — B2 read-only key
- `.github/workflows/check.yml` — daemon credentials, push step, prune step
- A prune script in the repo

**Out:**

- The service module itself — container, caddy, the app's own runtime secrets,
  backup registration. That is a separate design with its own spec.
- Caching encode_queue. It is public, redtruck does not auto-upgrade, and the
  saving is one Rust compile on a workstation. Trivial to add later.
- Any change to `autoUpgrade`, the `verified` ref, or push-based deployment.
- Other hosts. elitebook, paynefield, t495, redtruck and mac are untouched.

## Approach

### Packaging

`modules/<app>/package.nix` mirrors `modules/encode_queue/package.nix`, with:

```nix
src = fetchFromGitHub {
  owner = "BJSummerfield";
  repo = "<repo>";
  rev = "<commit sha>";
  sha256 = "...";
  private = true;
};
cargoLock.lockFile = "${src}/Cargo.lock";
```

`private = true` adds a `netrcPhase` building a netrc from
`NIX_GITHUB_PRIVATE_USERNAME` / `NIX_GITHUB_PRIVATE_PASSWORD`, declares those
two names in `netrcImpureEnvVars`, and rewrites the URL to
`https://api.github.com/repos/<owner>/<repo>/tarball/<rev>`. `fetchurl`'s
builder then runs the phase and passes `--netrc-file` to curl.

Adding `<app>` to `packages` also creates `packages.aarch64-darwin.<app>`,
which would fail if anyone built it. encode_queue has the same property today;
the inconsistency is left alone rather than special-cased.

### Credentials in CI

`impureEnvVars` is honoured only for fixed-output derivations, and the values
come from the environment of *the process performing the build*. Under a
multi-user install that is nix-daemon, not the workflow shell — a plain
`export` in a step will not reach the builder. `install-nix-action` performs a
multi-user install on Linux.

The intended mechanism is a systemd drop-in for `nix-daemon.service` written
before the build step, followed by `systemctl restart nix-daemon`. **This is
the one unverified piece of the design.** The fallback, if it does not work, is
a single-user install (`install_options: --no-daemon`), where the invoking
process performs the build and `export` suffices. This is prototyped first
because it is the least-trodden part and the cheapest to falsify.

### Bucket and keys

A new bucket, `spacefunk-nix-cache`, with two bucket-scoped B2 application
keys.

| Item | Lives in | Scope |
|---|---|---|
| GitHub PAT | nixcfg Actions secret | fine-grained, Contents:Read, one repo |
| Cache signing key (private) | nixcfg Actions secret | signs narinfo |
| Cache signing key (public) | `trusted-public-keys`, in-tree plaintext | — |
| B2 write key | nixcfg Actions secret | write + delete, one bucket |
| B2 read key | sops, `secrets/hosts/vps.yaml` | `readFiles`, `listFiles`, one bucket |

The signing keypair is generated once with
`nix-store --generate-binary-cache-key`. vps has `require-sigs = true`, so an
unsigned or wrongly-signed path is rejected regardless of who can write to the
bucket.

### Push and prune

Ordered within the workflow so that a failure never leaves hosts pointing at a
config whose closure is absent:

```
nix flake check  →  nix copy to B2  →  advance `verified`  →  prune
```

`nix flake check` already builds `pkg-<app>`, so the artifact is in the
runner's store and `nix copy` only uploads. `verified` advances only after the
push succeeds; pruning happens last so the window in which the old closure is
needed has closed. The last two steps are guarded to `github.event_name ==
'push'`.

Retention is tracked by a manifest rather than inferred. Each push writes
`manifests/<commit-sha>.json` into the bucket, listing the store paths of that
build's closure as computed by `nix path-info -r`. The prune step keeps the two
most recent manifests, takes the union of the paths they name, and deletes
every object in the bucket that is neither one of those paths nor one of those
two manifests.

This makes retention explicit and auditable — the bucket states what it is
keeping and why — and avoids depending on object timestamps, which `nix copy`
does not refresh.

### vps configuration

A `mine.system.privateCache` option under the existing namespace, following the
shape `modules/nvidia/nixos.nix:46` already uses to add the cuda-maintainers
substituter and its key. It sets `nix.settings.substituters` and
`trusted-public-keys`, and points
`systemd.services.nix-daemon.serviceConfig.EnvironmentFile` at the sops path
holding `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

nix 2.34.8 links `libaws-c-s3`; a store URI of the form
`s3://spacefunk-nix-cache?endpoint=s3.<region>.backblazeb2.com&region=<region>`
parses and resolves to
`https://s3.<region>.backblazeb2.com/spacefunk-nix-cache/nix-cache-info`,
failing only on absent credentials. Credentials are sourced from the standard
AWS chain, so environment variables are sufficient.

### Rollout

`nixos-rebuild` builds the new closure using the *current* nix.conf and only
then activates the new one. A single deploy adding both the substituter and the
app would therefore compile the app with the substituter not yet in effect —
once, on the 1 GB box. Three steps:

1. Land the substituter, public key and B2 read credentials on vps. Deploy.
   Confirm vps can reach the bucket.
2. Land the package and the CI push. Let CI build and push. Confirm the object
   exists.
3. Let vps pull. Confirm it substituted rather than built.

## Failure modes

- **PAT expires.** `nix flake check` fails, `verified` stops advancing, and all
  three auto-upgrading hosts freeze on their last good build — including
  elitebook and paynefield, which have nothing to do with this app. Not a new
  failure mode (a red CI already halts `verified` by design) but a new cause,
  and a slow-burn one. Mitigate with a calendar reminder before expiry.
- **B2 unreachable at 04:00.** nix warns and falls back to other substituters;
  since nothing else serves this path, vps attempts to build it and may OOM.
  Detected by the app's service failing to start rather than silently.
- **Prune deletes a live path.** Prevented by reference-based pruning,
  keep-2 retention, and the `push`-only guard. A time-based B2 lifecycle rule
  would reintroduce this and must not be added.
- **Signing key lost.** Regenerate, update the Actions secret and
  `trusted-public-keys`, re-push. No data loss; the bucket is derived state.
- **Cargo git dependencies on other private repos.** These take a different
  code path and would not pick up the netrc. Out of scope; the app must use
  crates.io only.

## Verification

- `nix flake check` stays green and lists `pkg-<app>` among its checks.
- `nix path-info --store 's3://spacefunk-nix-cache?endpoint=…' <path>` run on
  vps returns the path, proving the read-only key works.
- `nixos-rebuild build --dry-run` on vps reports the app as *fetched*, not
  *built*. This is the actual success criterion — a green build that quietly
  compiled has failed.
- After a third CI run on `main` that changes the app's `rev`, the bucket holds
  two manifests and two closures, not three.
- The other four hosts' `system.build.toplevel` drvPaths are unchanged.

## Success Criteria

- vps runs the private app.
- vps holds no GitHub credential of any kind.
- vps has never compiled the app.
- No host other than vps changed.
- The bucket does not grow without bound, and no scheduled job outside CI
  exists to keep it that way.
