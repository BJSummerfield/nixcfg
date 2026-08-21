# Nix Binary Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a private B2-backed Nix binary cache that nixcfg CI writes to and hosts read from, prove it end to end with the public `encode_queue` package on redtruck, then use it to deliver the private `photoform` package to vps — so vps never holds a GitHub credential and never compiles it.

**Architecture:** CI builds, signs, and pushes selected packages to a private B2 bucket; hosts add it as a substituter with a shared read-only key. `photoform` uses `fetchFromGitHub { private = true; }`, whose store path derives from a declared hash, so hosts evaluate the flake with no credential and the source is fetched only by the machine that builds it — CI. Retention is manifest-driven, pruned to the last two builds.

**Tech Stack:** Nix 2.34.8, nixpkgs `0ae2bc1` (nixos-unstable), `rustPlatform.buildRustPackage`, sops-nix, GitHub Actions, Backblaze B2 S3-compatible API, awscli2.

**Spec:** `docs/superpowers/specs/2026-08-18-private-app-binary-cache-design.md`

## Sequencing, and why it changed

The cache and the private fetch are independent problems, and the private fetch is the risky one. `encode_queue`'s source is **public**, so every part of the cache — bucket, keys, signing, push, manifest, prune, substituter module, daemon credentials, real substitution on a real host — can be proven with **no PAT at all**. Tasks 2–7 do exactly that against redtruck. Only Tasks 8–9 introduce the private repo.

This also keeps CI green throughout. The moment `photoform` is in `packages`, `nix flake check` builds it and needs the PAT; without one, CI goes red and `verified` stops advancing, freezing elitebook, paynefield and vps. So Task 2 deliberately holds `photoform` out of `packages` until Task 8 restores it alongside the token.

## Global Constraints

- B2 bucket: `spacefunk-nix-cache`. Endpoint `s3.us-east-005.backblazeb2.com`, region `us-east-005`.
- **What gets cached is opt-in per package via `passthru.cache = true`.** Membership in `packages` means CI *builds* a package; it does not mean anything needs it cached. CI derives the push list from the marker, so adding a package later is one line next to that package.
- **One shared read-only B2 key serves every host**, from `secrets/services/nix-cache-b2.yaml`. It is not an `impureEnvVar` and is never handed to a build, so it does not carry the exfiltration risk a GitHub PAT would. Rotation is one file.
- Retention: keep the 2 most recent manifests and everything they reference. The manifest is the `sort -u` union of every cached package's closure.
- Cache writes and prunes run **only** on `github.event_name == 'push'`. Never on `pull_request`.
- Never add a time-based B2 lifecycle rule to this bucket. `nix copy` skips paths already present, so object timestamps do not track whether a path is still in use.
- **A derivation references `src` only through its declared hash.** Never read a file out of `src` — no `cargoLock.lockFile = "${src}/Cargo.lock"`, no `builtins.readFile "${src}/..."`. That is import-from-derivation: it makes *evaluation* fetch the source, which for a private repo would require a GitHub credential on every host. Task 1 Step 4 is the regression test.
- Package/attribute name for the private app is `photoform` (lowercase); its binary is `nesting-box-booking`. These differ on purpose.
- Comments state the reason in one sentence, lead with the conclusion, carry no history and no cross-references, per `docs/superpowers/specs/2026-08-09-comment-style-design.md`.
- Run `nix fmt` before committing any `.nix` change; the formatter is `nixfmt-tree`.
- Sub-project B (container, caddy routing, PhotoForm's runtime secrets, backup registration) is out of scope. This plan never puts `photoform` into a host's closure.

---

## File Structure

| File | Responsibility |
|---|---|
| `modules/photoform/package.nix` | **Create.** The private derivation. Sole place the private repo is named. |
| `modules/encode_queue/package.nix` | **Modify.** Gains `passthru.cache = true`. |
| `flake.nix` | **Modify.** `photoform` in `packages` (deferred to Task 8); comment pointing at the marker. |
| `ci/prune-cache.sh` | **Create.** Manifest-driven retention. The only thing that deletes from the bucket. |
| `.github/workflows/check.yml` | **Modify.** Daemon credentials, push, manifest, prune. |
| `modules/system/nixos.nix` | **Modify.** New `mine.system.privateCache` option, owning its own sops secret. |
| `secrets/services/nix-cache-b2.yaml` | **Create.** Shared B2 read key, encrypted to every host. |
| `.sops.yaml` | **Modify.** Creation rule for the shared file. |
| `hosts/redtruck/default.nix`, `hosts/vps/default.nix` | **Modify.** One line each to enable the cache. |

There is no `modules/photoform/nixos.nix` here. The service module is sub-project B, and it is what would first put `photoform` into vps's closure — so Task 9 must pass before it lands.

---

## Task 1: The photoform derivation — ALREADY COMPLETE

Implemented and reviewed at commit `f133e3f` (Steps 1–4). Recorded here for context; **do not redo it**. Its remaining steps — obtaining the PAT, pushing, and reading the real hashes out of CI — moved to Task 8, because they need a credential that did not exist when this task ran.

What it produced: `modules/photoform/package.nix` using `fetchFromGitHub { private = true; }` with `lib.fakeSha256` / `lib.fakeHash` placeholders and `meta.mainProgram = "nesting-box-booking"`; the `photoform` entry in `flake.nix`'s `packages`; and the nix-daemon credential step in `.github/workflows/check.yml`.

Its Step 4 verification — `nix eval --raw .#packages.x86_64-linux.photoform.drvPath` returning a plain `.drv` path with no fetch — is the regression test for the import-from-derivation constraint. It passed.

---

## Task 2: Opt encode_queue into the cache, hold photoform out of packages

**Files:**
- Modify: `modules/encode_queue/package.nix`
- Modify: `flake.nix`

**Interfaces:**
- Produces: the `passthru.cache` marker convention; a `packages` set containing only `encode_queue`, so CI needs no PAT.

- [ ] **Step 1: Mark encode_queue for caching**

In `modules/encode_queue/package.nix`, add a `passthru` attribute immediately before `meta`:

```nix
  # Opt in to the binary cache so redtruck substitutes it instead of compiling.
  passthru.cache = true;
```

The flag lives on the package rather than in a separate list so it cannot name a package that does not exist.

- [ ] **Step 2: Remove photoform from `packages` for now**

In `flake.nix`, delete the `photoform` line added by Task 1, leaving:

```nix
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
        }
```

`modules/photoform/package.nix` stays on disk untouched — Task 8 restores this line. Removing it is what keeps `nix flake check` from needing the PAT while Tasks 3–7 prove the cache.

- [ ] **Step 3: Point at the marker where packages are declared**

Extend the existing comment above the `packages` block so the convention is discoverable:

```nix
      # Exposed so `nix build .#encode_queue` works and so the checks below
      # build it. Set `passthru.cache = true` on a package to have CI push it
      # to the private binary cache as well. bicep-langserver is deliberately
      # absent: no host enables it and its dotnet SDK dependency is a 712 MiB
      # closure.
```

- [ ] **Step 4: Verify the filter sees exactly encode_queue**

```bash
nix eval --json --apply 'ps: builtins.filter (n: (ps.${n}.cache or false)) (builtins.attrNames ps)' .#packages.x86_64-linux
```

Expected: exactly `["encode_queue"]`. `[]` means the marker did not land on the derivation. Any mention of `photoform` means Step 2 was not applied.

- [ ] **Step 5: Confirm the flake still checks clean without any token**

```bash
env -u GH_TOKEN -u GITHUB_TOKEN nix flake check --print-build-logs 2>&1 | tail -5
```

Expected: `all checks passed!`, with no `photoform` and no authentication error anywhere in the log.

- [ ] **Step 6: Commit**

```bash
nix fmt
git add modules/encode_queue/package.nix flake.nix
git commit -m "feat(cache): opt encode_queue in, defer photoform until the PAT exists

Being in \`packages\` means CI builds it, not that anything needs it cached,
so membership is an explicit marker on the package. photoform leaves
\`packages\` until Task 8: it cannot build without a token, and a red check
stops \`verified\` advancing for every auto-upgrading host."
```

---

## Task 3: Create the bucket, keys, and signing key

External setup plus verification. No repository files change, so it ends with a verified capability rather than a commit.

**Interfaces:**
- Produces: bucket `spacefunk-nix-cache`; Actions secrets `B2_CACHE_KEY_ID`, `B2_CACHE_APP_KEY`, `NIX_CACHE_SIGNING_KEY`; the cache public key string and the read key, both consumed by Task 6.

- [ ] **Step 1: Create the bucket**

In the Backblaze console, create a **private** bucket named `spacefunk-nix-cache`. Do not reuse `spacefunk-mail-backups`: `ci/prune-cache.sh` deletes objects by default and must never be able to reach restic data.

Do **not** configure any lifecycle rule on this bucket.

- [ ] **Step 2: Create two bucket-scoped application keys**

Both restricted to `spacefunk-nix-cache` only.

| Key | Capabilities | Goes to |
|---|---|---|
| write key | `listFiles`, `readFiles`, `writeFiles`, `deleteFiles` | Actions secrets |
| read key | `listFiles`, `readFiles` | `secrets/services/nix-cache-b2.yaml`, shared by all hosts |

Record both `keyID` / `applicationKey` pairs. B2 shows an application key exactly once.

- [ ] **Step 3: Generate the cache signing keypair**

```bash
nix-store --generate-binary-cache-key spacefunk-nix-cache-1 /tmp/cache-key.sec /tmp/cache-key.pub
cat /tmp/cache-key.pub
```

Expected: a line of the form `spacefunk-nix-cache-1:<base64>`. Record it verbatim; Task 6 needs it.

- [ ] **Step 4: Add the Actions secrets**

In the nixcfg repository settings, add `B2_CACHE_KEY_ID` (write keyID), `B2_CACHE_APP_KEY` (write applicationKey), and `NIX_CACHE_SIGNING_KEY` (the full contents of `/tmp/cache-key.sec`). Then:

```bash
shred -u /tmp/cache-key.sec
```

- [ ] **Step 5: Verify the write key works**

```bash
export AWS_ACCESS_KEY_ID=<write keyID>
export AWS_SECRET_ACCESS_KEY=<write applicationKey>
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls s3://spacefunk-nix-cache/
```

Expected: exits 0, prints nothing.

`InvalidAccessKeyId` means the region is wrong — check the S3 endpoint shown beside the bucket in the console matches `s3.us-east-005.backblazeb2.com` exactly, and correct the Global Constraints value everywhere if not.

- [ ] **Step 6: Verify the read key cannot write**

```bash
export AWS_ACCESS_KEY_ID=<read keyID>
export AWS_SECRET_ACCESS_KEY=<read applicationKey>
echo test > /tmp/canary
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 cp /tmp/canary s3://spacefunk-nix-cache/canary
```

Expected: **fails** with access denied. Success means the read key is over-scoped — recreate it with only `listFiles` and `readFiles`.

---

## Task 4: Push signed closures and a manifest from CI

**Files:**
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: the marker from Task 2; the Actions secrets from Task 3.
- Produces: bucket objects `nix-cache-info`, `<hash>.narinfo`, `nar/<...>`, and `manifests/<zero-padded-run-number>-<sha>.json` holding a JSON array of the union of every cached package's closure.

Note the asymmetry, because it confuses people later: `nix copy --to` is performed by the **client**, so step-level environment variables suffice here. Substitution on a host happens in whichever process realises the path — the daemon for non-root clients, but root's own nix client for `nixos-rebuild` and `autoUpgrade`, since root operates on the store directly and never consults the daemon — which is why Task 6 gives credentials to all three.

- [ ] **Step 1: Add the push step**

In `.github/workflows/check.yml`, insert after the `nix flake check` step and **before** the existing `Advance verified` step:

```yaml
      # Runs before the ref advances so hosts never see a config whose closure
      # is not yet in the cache.
      - name: Push cached packages to the binary cache
        if: github.event_name == 'push'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.B2_CACHE_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.B2_CACHE_APP_KEY }}
          CACHE_STORE: s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005
        run: |
          mapfile -t attrs < <(nix eval --json --apply \
            'ps: builtins.filter (n: (ps.${n}.cache or false)) (builtins.attrNames ps)' \
            .#packages.x86_64-linux | jq -r '.[]')

          # An empty list means the marker was lost, not that there is nothing
          # to do; pushing nothing would silently leave hosts compiling.
          if [ "${#attrs[@]}" -eq 0 ]; then
            echo "no package sets passthru.cache = true" >&2
            exit 1
          fi
          echo "caching: ${attrs[*]}"

          umask 077
          printf '%s' "${{ secrets.NIX_CACHE_SIGNING_KEY }}" > "$RUNNER_TEMP/cache-key.sec"
          nix copy --to "$CACHE_STORE&secret-key=$RUNNER_TEMP/cache-key.sec" "${attrs[@]/#/.#}"
          shred -u "$RUNNER_TEMP/cache-key.sec"

          # Retention is manifest-driven because nix copy skips paths already
          # present, so object timestamps do not track whether a path is live.
          nix path-info -r "${attrs[@]/#/.#}" | sort -u | jq -R . | jq -s . > "$RUNNER_TEMP/manifest.json"
          nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
            s3 cp "$RUNNER_TEMP/manifest.json" \
            "s3://spacefunk-nix-cache/manifests/$(printf '%08d' "$GITHUB_RUN_NUMBER")-${GITHUB_SHA}.json"
```

The run number is zero-padded so manifest keys sort lexicographically in run order, which `ci/prune-cache.sh` relies on. `sort -u` matters once more than one package is cached — their closures overlap heavily and the manifest must be a set.

- [ ] **Step 2: Commit and merge to main**

```bash
git add .github/workflows/check.yml
git commit -m "ci(cache): push passthru.cache packages to B2 with a retention manifest"
git push
```

Merge to `main` so the guarded step actually runs.

- [ ] **Step 3: Verify the bucket contents**

With the **read** key exported:

```bash
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls --recursive s3://spacefunk-nix-cache/
```

Expected: `nix-cache-info`, several `.narinfo` objects, `nar/` objects, and exactly one `manifests/00000001-<sha>.json`-style key. The run log should read `caching: encode_queue`.

- [ ] **Step 4: Verify a pull request does not write**

Open a trivial PR. When its run finishes, repeat Step 3's listing.

Expected: **unchanged**, no new manifest. A new manifest means the `if: github.event_name == 'push'` guard is missing or misplaced.

- [ ] **Step 5: Verify the closure is signed**

```bash
nix path-info --store "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005" \
  --sigs $(nix eval --raw .#encode_queue)
```

Expected: output includes a `spacefunk-nix-cache-1:` signature. Hosts set `require-sigs = true`, so an unsigned path is rejected on arrival.

---

## Task 5: Prune the cache to the last two builds

**Files:**
- Create: `ci/prune-cache.sh`
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: manifests from Task 4; the write key.
- Produces: a bucket holding exactly the objects referenced by the newest `CACHE_KEEP` manifests, plus those manifests and `nix-cache-info`.

- [ ] **Step 1: Write the prune script**

Create `ci/prune-cache.sh`:

```bash
#!/usr/bin/env bash
# Prunes the Nix binary cache to the newest $CACHE_KEEP manifests.
#
# Retention is manifest-driven, never timestamp-driven: nix copy skips paths
# already present, so an object's LastModified does not track whether it is
# still in use, and any age-based rule would eventually delete a live NAR.
set -euo pipefail

# Byte collation so sort/comm/sort -u agree exactly on these keys.
export LC_ALL=C

BUCKET="${CACHE_BUCKET:?CACHE_BUCKET is required}"
ENDPOINT="${CACHE_ENDPOINT:?CACHE_ENDPOINT is required}"
KEEP="${CACHE_KEEP:-2}"

s3() { aws --endpoint-url "$ENDPOINT" "$@"; }
# grep exits 1 when it filters everything out, which under pipefail would abort
# the run before the empty-manifest guard below could report it.
keys() { tr '\t' '\n' | { grep -Ev '^(None)?$' || true; } | sort; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix manifests/ \
  --query 'Contents[].Key' --output text | keys > "$work/manifests-all"

tail -n "$KEEP" "$work/manifests-all" > "$work/manifests-keep"

# An empty manifest list would make every object unreferenced and delete the
# whole cache, so refuse rather than proceed.
if [ ! -s "$work/manifests-keep" ]; then
  echo "prune-cache: no manifests found in s3://$BUCKET/manifests/; refusing to prune" >&2
  exit 1
fi

: > "$work/paths-keep"
while read -r key; do
  s3 s3 cp "s3://$BUCKET/$key" - | jq -r '.[]' >> "$work/paths-keep"
done < "$work/manifests-keep"
sort -u "$work/paths-keep" -o "$work/paths-keep"

: > "$work/objects-keep"
while read -r path; do
  hash="${path#/nix/store/}"
  hash="${hash%%-*}"
  echo "$hash.narinfo" >> "$work/objects-keep"

  # Fail closed: an unreadable narinfo means we cannot know which NAR it
  # references, and assuming none would delete live data.
  if ! s3 s3 cp "s3://$BUCKET/$hash.narinfo" - > "$work/narinfo" 2>/dev/null; then
    echo "prune-cache: cannot read $hash.narinfo; refusing to prune" >&2
    exit 1
  fi

  nar=$(awk '/^URL: /{print $2}' "$work/narinfo")
  if [ -z "$nar" ]; then
    echo "prune-cache: $hash.narinfo has no URL: line; refusing to prune" >&2
    exit 1
  fi
  echo "$nar" >> "$work/objects-keep"
done < "$work/paths-keep"

cat "$work/manifests-keep" >> "$work/objects-keep"
echo "nix-cache-info" >> "$work/objects-keep"
sort -u "$work/objects-keep" -o "$work/objects-keep"

s3 s3api list-objects-v2 --bucket "$BUCKET" \
  --query 'Contents[].Key' --output text | keys > "$work/objects-all"

comm -23 "$work/objects-all" "$work/objects-keep" > "$work/objects-delete"

echo "prune-cache: keeping $(wc -l < "$work/objects-keep"), deleting $(wc -l < "$work/objects-delete")"

while read -r key; do
  s3 s3 rm "s3://$BUCKET/$key"
done < "$work/objects-delete"
```

- [ ] **Step 2: Commit the script on its own**

```bash
chmod +x ci/prune-cache.sh
git add ci/prune-cache.sh
git commit -m "ci(cache): manifest-driven retention

Refuses to run with no manifests, since that would read as 'nothing is
referenced' and empty the bucket."
```

- [ ] **Step 3: Dry-run it by hand with the READ key**

Using the read key means a logic bug cannot delete anything.

```bash
export AWS_ACCESS_KEY_ID=<read keyID>
export AWS_SECRET_ACCESS_KEY=<read applicationKey>
export CACHE_BUCKET=spacefunk-nix-cache
export CACHE_ENDPOINT=https://s3.us-east-005.backblazeb2.com
nix shell nixpkgs#awscli2 nixpkgs#jq -c ./ci/prune-cache.sh
```

Expected with one manifest present: `prune-cache: keeping N, deleting 0`, and no delete attempted. `deleting 0` is correct — every object is referenced by the only manifest.

A non-zero delete count here means something unreferenced is in the bucket. Stop and inspect before granting the write key.

- [ ] **Step 4: Add the prune step to the workflow**

Add **after** the existing `Advance verified` step, as the last step in the job:

```yaml
      # Last, so the previous closure stays fetchable until the ref has moved.
      - name: Prune the binary cache
        if: github.event_name == 'push'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.B2_CACHE_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.B2_CACHE_APP_KEY }}
          CACHE_BUCKET: spacefunk-nix-cache
          CACHE_ENDPOINT: https://s3.us-east-005.backblazeb2.com
          CACHE_KEEP: "2"
        run: nix shell nixpkgs#awscli2 nixpkgs#jq -c ./ci/prune-cache.sh
```

- [ ] **Step 5: Commit and merge**

```bash
git add .github/workflows/check.yml
git commit -m "ci(cache): prune after the ref advances"
git push
```

- [ ] **Step 6: Verify retention across three builds**

Pruning is only exercised on the third build, so all three are needed. Push three commits to `main` that each change `encode_queue`'s `rev` to a different real commit (or bump nixpkgs). After the third run:

```bash
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls s3://spacefunk-nix-cache/manifests/
```

Expected: exactly **two** manifest objects, the two most recent, and the third run's log reads `prune-cache: keeping N, deleting M` with `M` greater than zero.

---

## Task 6: The privateCache module, enabled on redtruck

**Files:**
- Modify: `.sops.yaml`
- Create: `secrets/services/nix-cache-b2.yaml`
- Modify: `modules/system/nixos.nix`
- Modify: `hosts/redtruck/default.nix`

**Interfaces:**
- Consumes: the cache public key from Task 3 Step 3; the read key from Task 3 Step 2.
- Produces: `mine.system.privateCache.enable`, a one-line opt-in for any host.

The key is shared by every host deliberately. It is a read-only credential over build artifacts, it is **not** an `impureEnvVar` and so is never handed to a build, and one file means rotation happens in one place.

- [ ] **Step 1: Add the sops creation rule**

In `.sops.yaml`, add this **before** the final catch-all `secrets/.*\.yaml$` rule — sops takes the first matching rule, and the catch-all encrypts only to the two user keys, which no host could decrypt:

```yaml
  - path_regex: secrets/services/nix-cache-b2\.yaml$
    key_groups:
      - age:
          - *waktu_redtruck
          - *waktu_t495
          - *host_redtruck
          - *host_t495
          - *host_paynefield
          - *host_elitebook
          - *host_vps
```

- [ ] **Step 2: Create the shared secret**

```bash
nix shell nixpkgs#sops -c sops secrets/services/nix-cache-b2.yaml
```

Content, matching the shape `restic-stalwart-b2-env` uses:

```yaml
nix-cache-b2-env: |
    AWS_ACCESS_KEY_ID=<read keyID>
    AWS_SECRET_ACCESS_KEY=<read applicationKey>
```

- [ ] **Step 3: Confirm every host key is a recipient**

```bash
nix shell nixpkgs#sops -c sops -d --extract '["sops"]["age"]' secrets/services/nix-cache-b2.yaml | grep -c recipient
```

Expected: `7`. A lower number means the rule was added after the catch-all and did not match.

- [ ] **Step 4: Add the option**

In `modules/system/nixos.nix`, inside `options.mine.system`, beside the existing `autoUpgrade.enable`:

```nix
    privateCache.enable = mkEnableOption "the shared B2 binary cache as a substituter";
```

- [ ] **Step 5: Add the config block**

Add a new element to the existing `mkMerge` list, alongside the `mkIf cfg.autoUpgrade.enable` block:

```nix
    (mkIf cfg.privateCache.enable {
      sops.secrets.nix-cache-b2-env = {
        sopsFile = ../../secrets/services/nix-cache-b2.yaml;
        mode = "0400";
      };

      nix.settings = {
        substituters = [
          "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005"
        ];
        trusted-public-keys = [
          "spacefunk-nix-cache-1:<public key from Task 3 Step 3>"
        ];
      };

      # Substitution runs in the daemon, so the credentials belong in its
      # environment rather than the caller's.
      systemd.services.nix-daemon.serviceConfig.EnvironmentFile =
        config.sops.secrets.nix-cache-b2-env.path;
    })
```

Substitute the real public key. `substituters` and `trusted-public-keys` are list-typed and merge, so `cache.nixos.org` is retained. The module owns its secret because the file is identical on every host — there is nothing per-host to parameterise.

- [ ] **Step 6: Enable on redtruck**

In `hosts/redtruck/default.nix`, inside `mine.system`:

```nix
      privateCache.enable = true;
```

- [ ] **Step 7: Check and confirm the blast radius**

```bash
nix fmt
nix flake check --print-build-logs 2>&1 | tail -3
for h in elitebook paynefield t495 vps; do
  echo -n "$h "; nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
done
```

Expected: checks pass, and those four drvPaths are unchanged from before this task — only redtruck's should differ.

- [ ] **Step 8: Commit and deploy to redtruck**

```bash
git add .sops.yaml secrets/services/nix-cache-b2.yaml modules/system/nixos.nix hosts/redtruck/default.nix
git commit -m "feat(cache): shared B2 substituter, enabled on redtruck

One read-only key for all hosts: it covers build artifacts only, is never
handed to a build the way an impureEnvVar would be, and rotating it is one
file."
git push
```

Then on redtruck:

```bash
sudo nixos-rebuild switch --flake .
sudo systemctl restart nix-daemon
```

The explicit restart is needed once — sops writes the secret during activation, and the running daemon does not pick up a new `EnvironmentFile` by itself.

---

## Task 7: Prove redtruck substitutes encode_queue

The end-to-end proof of the whole cache, using a public package and no PAT.

- [ ] **Step 1: Confirm redtruck can read the bucket**

On redtruck, testing the key and bucket rather than the daemon:

```bash
set -a; source /run/secrets/nix-cache-b2-env; set +a
nix path-info --store "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005" \
  $(nix eval --raw .#encode_queue)
```

Expected: the store path prints. `AccessDenied` means the read key or endpoint region is wrong.

- [ ] **Step 2: Drop the local copy so substitution is observable**

encode_queue is already in redtruck's store, which would make any test vacuous.

```bash
nix eval --raw .#encode_queue          # note this path
nix store delete "$(nix eval --raw .#encode_queue)"
```

If `nix store delete` refuses because a profile or GC root still references it, that is fine — instead verify with `--dry-run` in Step 3 and read the "will be fetched" list.

- [ ] **Step 3: Confirm the daemon substitutes**

In a shell with **no** AWS variables set, so only the daemon's credentials are in play:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  nix build --no-link --print-build-logs .#encode_queue
```

Expected: `copying path '/nix/store/...-encode_queue-unstable' from 's3://spacefunk-nix-cache...'`.

**This is the success criterion for the cache.** Rust compilation output instead means the substituter is not being consulted — check `nix show-config | grep substituters` lists the s3 URL, and that `systemctl restart nix-daemon` ran after the secret appeared.

- [ ] **Step 4: Confirm signature enforcement is real**

```bash
nix show-config | grep -E 'require-sigs|trusted-public-keys'
```

Expected: `require-sigs = true` and the `spacefunk-nix-cache-1:` key present. This is what makes bucket write access alone insufficient to poison a host.

- [ ] **Step 5: Record the milestone**

```bash
git commit --allow-empty -m "chore(cache): binary cache proven end to end on redtruck

redtruck substitutes encode_queue from B2 with signature verification. No
GitHub credential involved anywhere in this path."
git push
```

---

## Task 8: Introduce the private repo

Everything from here needs the PAT. The cache is already proven, so any failure in this task is a credential or fetch failure, never a cache failure — which is the entire point of the ordering.

**Files:**
- Modify: `flake.nix`
- Modify: `modules/photoform/package.nix`

**Prerequisite (by hand):** create a GitHub fine-grained personal access token with **Contents: Read** on `BJSummerfield/Sheet-Automation-FF` only, and add it to nixcfg's Actions secrets as `PHOTOFORM_PAT`. Fine-grained tokens work because nixpkgs routes private fetches through the `api.github.com` tarball endpoint; a classic token is not required.

There are **two** hashes to discover and they must be found in order — `cargoHash` cannot be computed until the source fetch succeeds — so expect three CI runs.

- [ ] **Step 1: Restore photoform to `packages` and mark it**

In `flake.nix`:

```nix
          photoform = pkgs.callPackage ./modules/photoform/package.nix { };
```

In `modules/photoform/package.nix`, add before `meta`:

```nix
  # Opt in to the binary cache: vps has 1 GB of RAM and cannot compile this.
  passthru.cache = true;
```

- [ ] **Step 2: Push and read the source hash**

```bash
nix fmt
git add flake.nix modules/photoform/package.nix
git commit -m "wip(photoform): into packages with placeholder hashes"
git push
```

Expected in the run log:

```
error: hash mismatch in fixed-output derivation '/nix/store/...-source.drv':
         specified: sha256-AAAAAAAA...
            got:    sha256-<the real source hash>
```

A hash mismatch means the fetch **authenticated and downloaded** — that is success for this step. Record the `got:` value.

Other outcomes and what they mean:

| Log shows | Meaning | Action |
|---|---|---|
| `Private fetchFromGitHub requires the nix building process (nix-daemon in multi user mode) to have the NIX_GITHUB_PRIVATE_USERNAME and NIX_GITHUB_PRIVATE_PASSWORD env vars set.` | the systemd drop-in did not reach the daemon | go to Step 3 |
| `HTTP error 404` | token lacks Contents:Read, or wrong repo | fix the token scope |
| `HTTP error 401` | token malformed or expired | regenerate it |

- [ ] **Step 3: Fallback ONLY if Step 2 showed the "env vars set" error**

Skip entirely if Step 2 produced a hash mismatch.

Replace the install step with a single-user install, where the invoking process performs the build so a plain environment variable reaches it:

```yaml
      - uses: cachix/install-nix-action@v31
        with:
          install_options: --no-daemon
```

and replace the whole "Give nix-daemon the private-repo credentials" step with an `env:` block on the check step:

```yaml
      - run: nix flake check --print-build-logs
        env:
          NIX_GITHUB_PRIVATE_USERNAME: x-access-token
          NIX_GITHUB_PRIVATE_PASSWORD: ${{ secrets.PHOTOFORM_PAT }}
```

Push and repeat Step 2.

- [ ] **Step 4: Substitute the source hash, read the vendor hash**

Replace `sha256 = lib.fakeSha256;` with `sha256 = "sha256-<value from Step 2>";`. Leave `cargoHash = lib.fakeHash;` and the `lib` argument alone.

```bash
nix fmt && git add -A && git commit -m "wip(photoform): real source hash" && git push
```

Expected: the source fetch succeeds and the run now fails at the cargo vendor stage with a second mismatch naming a `-vendor.tar.gz` derivation. Record that `got:` value.

- [ ] **Step 5: Substitute the vendor hash and drop `lib`**

```nix
  cargoHash = "sha256-<value from Step 4>";
```

`lib` is now unused — remove it from the argument set.

```bash
nix fmt && git add -A
git commit -m "feat(photoform): package the private repo at a pinned commit"
git push
```

Expected: green, and the push step's log reads `caching: encode_queue photoform`.

**If it fails inside the Rust compile with an sqlx error** mentioning `DATABASE_URL`, the app has gained a compile-time-checked query. Fix it upstream: run `cargo sqlx prepare` in the app repo, commit the `.sqlx/` directory, bump `rev`. Do not add a database to the Nix build.

- [ ] **Step 6: Re-verify credential-free evaluation**

The regression test from Task 1, now that real hashes are in place:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN nix eval --raw .#packages.x86_64-linux.photoform.drvPath
```

Expected: a plain `.drv` path with no fetch. A `hash mismatch ...-source.drv` error means import-from-derivation crept back in and hosts would now need the token.

---

## Task 9: Enable the cache on vps and prove photoform substitutes

- [ ] **Step 1: Enable on vps**

In `hosts/vps/default.nix`, inside `mine.system`:

```nix
      privateCache.enable = true;
```

That is the whole change — the module owns the secret, and `secrets/services/nix-cache-b2.yaml` is already encrypted to `host_vps` from Task 6.

```bash
nix fmt
git add hosts/vps/default.nix
git commit -m "feat(vps): consume the shared binary cache"
git push
```

- [ ] **Step 2: Deploy and restart the daemon**

Merge to `main`, wait for `verified` to advance, then on vps:

```bash
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified
sudo systemctl restart nix-daemon
```

`restartUnits` on the sops secrets now restarts `nix-daemon.service` automatically whenever the credential changes, but the first deploy after the direct-store-root fix still wants this one manual restart.

- [ ] **Step 3: Prove substitution**

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  nix build --no-link --print-build-logs github:BJSummerfield/nixcfg/verified#photoform
```

Expected: `copying path '/nix/store/...-photoform-unstable' from 's3://spacefunk-nix-cache...'`.

**This is the success criterion for the whole plan.** Be ready to interrupt: Rust compilation here is the 1 GB OOM risk the design exists to avoid, and Stalwart shares that memory.

- [ ] **Step 4: Confirm vps holds no GitHub credential**

```bash
sudo grep -ri "NIX_GITHUB_PRIVATE" /etc/systemd/system/ /run/secrets/ 2>/dev/null; echo "exit: $?"
```

Expected: no matches.

- [ ] **Step 5: Record completion**

```bash
git commit --allow-empty -m "chore(photoform): verified end to end on vps

vps substitutes photoform from B2, holds no GitHub credential, and has never
compiled it."
git push
```

---

## Follow-ups deliberately not in this plan

- **Sub-project B** — the nspawn container, caddy routing, PhotoForm's runtime secrets (SQLite path, SMTP, JWT, PayPal), and `mine.backups` registration. Needs its own spec. It is what first puts `photoform` into vps's closure, so Task 9 must pass first. Note `deploy/backup.sh` in the app repo shells out to `sqlite3 .backup`.
- **PAT expiry** — a fine-grained token expires on a schedule. When it does, `nix flake check` fails, `verified` stops advancing, and elitebook and paynefield freeze alongside vps despite having nothing to do with this app. Set a calendar reminder for a week before expiry.
- **Read-key reach** — once photoform is in the bucket, every host holding the shared read key can fetch the compiled private binary. That is accepted (it is a read-only artifact credential, not source access, and not an `impureEnvVar`). Revisit only if a host stops being trusted.
