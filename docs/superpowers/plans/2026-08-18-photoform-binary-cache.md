# PhotoForm Binary Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the private `BJSummerfield/Sheet-Automation-FF` repo as the `photoform` Nix package, built by nixcfg CI and served to vps from a private B2 binary cache, so vps never holds a GitHub credential and never compiles it.

**Architecture:** `fetchFromGitHub { private = true; }` keeps the source out of evaluation — a fixed-output derivation's store path comes from its declared hash, so hosts evaluate the flake with no credential. nixcfg's own CI does the build (only it has nixcfg's `flake.lock`, so only it produces store paths vps will ask for), pushes the signed closure to B2, and prunes to the last two manifests. vps adds the bucket as a substituter with a read-only key.

**Tech Stack:** Nix 2.34.8, nixpkgs `e5bdc4a` (nixos-unstable), `rustPlatform.buildRustPackage`, sops-nix, GitHub Actions, Backblaze B2 S3-compatible API, awscli2.

**Spec:** `docs/superpowers/specs/2026-08-18-private-app-binary-cache-design.md`

## Global Constraints

- Package/attribute name: `photoform` (lowercase). Directory `modules/photoform/`, flake attribute `packages.<system>.photoform`, check name `pkg-photoform`.
- Source repo: `BJSummerfield/Sheet-Automation-FF`. It appears exactly once, in `modules/photoform/package.nix`, so a rename is a one-line change.
- B2 bucket: `spacefunk-nix-cache`. Endpoint `s3.us-east-005.backblazeb2.com`, region `us-east-005`.
- Retention: keep the 2 most recent manifests and everything they reference.
- Cache writes and prunes run **only** on `github.event_name == 'push'`. Never on `pull_request`.
- Never add a time-based B2 lifecycle rule to this bucket. `nix copy` skips paths already present, so object timestamps do not track whether a path is still in use.
- **The derivation references `src` only through its declared hash.** Never read a file out of `src` — no `cargoLock.lockFile = "${src}/Cargo.lock"`, no `builtins.readFile "${src}/..."`. That is import-from-derivation: it makes *evaluation* fetch the private source, which would require a GitHub credential on every host and defeat the whole design. Task 1 Step 4 is the regression test for this.
- Comments state the reason in one sentence, lead with the conclusion, carry no history and no cross-references, per `docs/superpowers/specs/2026-08-09-comment-style-design.md`.
- Run `nix fmt` before committing any `.nix` change; the formatter is `nixfmt-tree`.
- Sub-project B (the container, caddy routing, PhotoForm's own runtime secrets, backup registration) is out of scope. This plan does not put `photoform` into any host's closure.

---

## File Structure

| File | Responsibility |
|---|---|
| `modules/photoform/package.nix` | **Create.** The derivation. Sole place the private repo is named. |
| `flake.nix` | **Modify.** Expose `photoform` in `packages`; `checks` picks up `pkg-photoform` automatically. |
| `ci/prune-cache.sh` | **Create.** Manifest-driven retention. The only thing that deletes from the bucket. |
| `.github/workflows/check.yml` | **Modify.** Daemon credentials, push, manifest, prune. |
| `modules/system/nixos.nix` | **Modify.** New `mine.system.privateCache` option. |
| `hosts/vps/default.nix` | **Modify.** Declare the sops secret, enable the option. |
| `secrets/hosts/vps.yaml` | **Modify.** B2 read-only key. |

There is no `modules/photoform/nixos.nix` in this plan. The service module belongs to sub-project B, and adding it here would put `photoform` into vps's closure before the cache is proven — the one ordering mistake this design exists to avoid.

**A deliberate departure from the spec's rollout order.** The spec lists the substituter as rollout step 1 and the package as step 2, because a single deploy adding both would compile the app before the substituter took effect. That hazard does not exist inside this plan: nothing here puts `photoform` into vps's closure, so vps never tries to build it regardless of ordering. Tasks are therefore ordered by risk instead — the unverified CI credential mechanism is Task 1, so a negative result costs one task rather than six. The spec's constraint survives intact in the form that actually matters: **Task 7 must pass before sub-project B lands.**

---

## Task 1: Prove CI can authenticate to the private repo

This is the only part of the design that was never verified. `impureEnvVars` are read from the environment of *the process performing the build*, which under a multi-user Nix install is nix-daemon, not the workflow shell. A plain `export` in a step will not reach the builder. Do this before anything else: a negative result changes the workflow, and it is the cheapest thing to falsify.

The task deliberately commits a **wrong hash**, so a successful authentication reports the real one. That keeps the PAT inside GitHub Actions and off your machines — notably off redtruck, which runs devbox containers for coding agents and where any user who can submit a derivation could read daemon environment variables.

**Files:**
- Create: `modules/photoform/package.nix`
- Modify: `flake.nix` (the `packages` block, around line 85)
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `packages.<system>.photoform`, a `rustPlatform.buildRustPackage` derivation; `checks.x86_64-linux.pkg-photoform` derived automatically by the existing `mapAttrs'` at `flake.nix:122`.

**Prerequisite (do this by hand, it is not a code change):**

Create a GitHub fine-grained personal access token with **Contents: Read** on `BJSummerfield/Sheet-Automation-FF` only. Add it to the nixcfg repository's Actions secrets as `PHOTOFORM_PAT`. Fine-grained tokens work here because nixpkgs routes private fetches through the `api.github.com` tarball endpoint; a classic token is not required.

- [ ] **Step 1: Create the derivation with a deliberately wrong hash**

Create `modules/photoform/package.nix`:

```nix
{
  rustPlatform,
  fetchFromGitHub,
  lib,
  ...
}:
rustPlatform.buildRustPackage {
  pname = "photoform";
  version = "unstable";
  src = fetchFromGitHub {
    owner = "BJSummerfield";
    repo = "Sheet-Automation-FF";
    rev = "4ed5a58e03b3c1aa5af5ca6ba179802ccdcde27f";
    sha256 = lib.fakeSha256;
    # Routes the fetch through api.github.com with a netrc built from
    # NIX_GITHUB_PRIVATE_USERNAME/PASSWORD in the nix-daemon environment.
    private = true;
  };
  # cargoHash, never cargoLock.lockFile: reading the lock file out of src is
  # import-from-derivation, so evaluation would fetch the private source and
  # every evaluator would need the GitHub credential.
  cargoHash = lib.fakeHash;
  meta = {
    description = "PhotoForm booking web service";
    mainProgram = "nesting-box-booking";
  };
}
```

Two values here are already resolved and must be used verbatim rather than re-derived:

- `rev` is `main`'s HEAD as of writing. Confirm it is still current with `gh api repos/BJSummerfield/Sheet-Automation-FF/commits/HEAD --jq .sha`; if it has moved, use the new value.
- `mainProgram` is `nesting-box-booking`, **not** `photoform`. `Cargo.toml` declares `[[bin]] name = "nesting-box-booking"`, so that is the only executable in `$out/bin`. The Nix-level `pname` stays `photoform`.

- [ ] **Step 2: Expose it as a flake output**

In `flake.nix`, the `packages` block currently reads:

```nix
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
        }
```

Change it to:

```nix
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
          photoform = pkgs.callPackage ./modules/photoform/package.nix { };
        }
```

- [ ] **Step 3: Give the CI nix-daemon the credentials**

In `.github/workflows/check.yml`, insert this step immediately after `- uses: cachix/install-nix-action@v31` and before the `nix flake check` step:

```yaml
      # impureEnvVars are read from the builder's environment, which is
      # nix-daemon under a multi-user install, so a shell export would not
      # reach the fetch.
      - name: Give nix-daemon the private-repo credentials
        run: |
          sudo mkdir -p /etc/systemd/system/nix-daemon.service.d
          sudo tee /etc/systemd/system/nix-daemon.service.d/private-repo.conf >/dev/null <<EOF
          [Service]
          Environment="NIX_GITHUB_PRIVATE_USERNAME=x-access-token"
          Environment="NIX_GITHUB_PRIVATE_PASSWORD=${{ secrets.PHOTOFORM_PAT }}"
          EOF
          sudo systemctl daemon-reload
          sudo systemctl restart nix-daemon
```

- [ ] **Step 4: Verify the flake still evaluates without credentials**

This is the most important check in the plan. Evaluation must not need the credential — that property is the entire reason this design uses a fixed-output derivation instead of a flake input. Run on any machine, with no GitHub token in the environment:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN nix eval --raw .#packages.x86_64-linux.photoform.drvPath
```

Expected: a `/nix/store/...-photoform-unstable.drv` path, printed immediately, with no network access.

**If it instead fails with `hash mismatch in fixed-output derivation '/nix/store/...-source.drv'`, evaluation is fetching the source.** That is import-from-derivation and it breaks the design — every host would need the credential just to evaluate. The known cause is reading a file out of `src` (for example `cargoLock.lockFile = "${src}/Cargo.lock"`). Do not proceed past this step until a plain `drvPath` is printed; the derivation must reference `src` only through its declared hash.

- [ ] **Step 5: Push the branch and read the CI result**

```bash
git add modules/photoform/package.nix flake.nix .github/workflows/check.yml
git commit -m "wip(photoform): private fetch with a placeholder hash to discover the real one"
git push -u origin HEAD
```

Open the Actions run and read the `nix flake check` log.

**Expected — success:** a hash mismatch, of the form

```
error: hash mismatch in fixed-output derivation '/nix/store/...-source.drv':
         specified: sha256-AAAAAAAA...
            got:    sha256-<the real hash>
```

A hash mismatch means the fetch *authenticated and downloaded*. That is the result this task is looking for. Record the `got:` value.

**Expected — failure modes and what they mean:**

| Log shows | Meaning | Action |
|---|---|---|
| `Error: Private fetchFromGitHub requires the nix building process (nix-daemon in multi user mode) to have the NIX_GITHUB_PRIVATE_USERNAME and NIX_GITHUB_PRIVATE_PASSWORD env vars set.` | The drop-in did not reach the daemon | Go to Step 6 |
| `HTTP error 404` | Token lacks Contents:Read, or the repo name is wrong | Fix the token scope, re-run |
| `HTTP error 401` | Token is malformed or expired | Regenerate the token |

- [ ] **Step 6: Fallback only if Step 5 showed the "env vars set" error**

Skip this step entirely if Step 5 produced a hash mismatch.

Replace the `install-nix-action` step with a single-user install, where the invoking process performs the build and a plain environment variable is sufficient:

```yaml
      - uses: cachix/install-nix-action@v31
        with:
          install_options: --no-daemon
```

and replace the whole "Give nix-daemon the private-repo credentials" step with an `env:` block on the `nix flake check` step:

```yaml
      - run: nix flake check --print-build-logs
        env:
          NIX_GITHUB_PRIVATE_USERNAME: x-access-token
          NIX_GITHUB_PRIVATE_PASSWORD: ${{ secrets.PHOTOFORM_PAT }}
```

Push again and repeat Step 5's check.

- [ ] **Step 7: Commit whichever credential mechanism worked**

```bash
git add .github/workflows/check.yml
git commit -m "ci(photoform): supply private-repo credentials to the nix builder

impureEnvVars come from the builder's environment, so the values have to
reach nix-daemon rather than the workflow shell."
```

---

## Task 2: Make the package build green

**Files:**
- Modify: `modules/photoform/package.nix`

**Interfaces:**
- Consumes: the real source hash recorded in Task 1 Step 5.
- Produces: a `photoform` derivation that builds; `pkg-photoform` passing in `nix flake check`.

There are **two** hashes to discover, and they must be found in order: `cargoHash` cannot be computed until the source fetch succeeds, so each one costs a CI round trip. Expect three runs in this task.

- [ ] **Step 1: Substitute the real source hash**

In `modules/photoform/package.nix`, replace

```nix
    sha256 = lib.fakeSha256;
```

with the `got:` value from Task 1 Step 5, quoted:

```nix
    sha256 = "sha256-<value recorded in Task 1>";
```

Leave `cargoHash = lib.fakeHash;` and the `lib` argument alone for now — both are still needed.

- [ ] **Step 2: Push and read the cargo vendor hash**

```bash
nix fmt
git add modules/photoform/package.nix
git commit -m "wip(photoform): real source hash, placeholder vendor hash"
git push
```

Expected: the source fetch now succeeds and the run fails later, at the cargo vendor stage, with a second hash mismatch naming a `-vendor.tar.gz` or `-cargo-deps` derivation:

```
error: hash mismatch in fixed-output derivation '/nix/store/...-photoform-unstable-vendor.tar.gz.drv':
         specified: sha256-AAAAAAAA...
            got:    sha256-<the real vendor hash>
```

Record the `got:` value. Reaching this error is progress — it means authentication and the source hash are both correct.

- [ ] **Step 3: Substitute the vendor hash and drop `lib`**

```nix
  cargoHash = "sha256-<value recorded in Step 2>";
```

`lib` is now unused, so remove it from the argument set:

```nix
{
  rustPlatform,
  fetchFromGitHub,
  ...
}:
```

- [ ] **Step 4: Push and confirm the build passes**

```bash
nix fmt
git add modules/photoform/package.nix
git commit -m "feat(photoform): package the private repo at a pinned commit"
git push
```

Expected: the Actions run is green.

**If it fails inside the Rust compile with an sqlx error** mentioning `DATABASE_URL` or `set DATABASE_URL to use query macros`, the app has gained a compile-time-checked query since this plan was written. The fix is upstream, not here: run `cargo sqlx prepare` in the app repo, commit the resulting `.sqlx/` directory, and bump `rev`. Do not add a database to the Nix build.

- [ ] **Step 5: Confirm the check is registered**

```bash
nix flake check --print-build-logs 2>&1 | tail -5
nix eval --json --apply 'builtins.attrNames' .#checks.x86_64-linux
```

Expected: the attribute list contains `pkg-photoform` alongside `pkg-encode_queue`.

---

## Task 3: Create the bucket, keys, and signing key

This task is external setup plus a verification. No repository files change, so it ends with a verified capability rather than a commit.

**Files:** none.

**Interfaces:**
- Produces: bucket `spacefunk-nix-cache`; Actions secrets `B2_CACHE_KEY_ID`, `B2_CACHE_APP_KEY`, `NIX_CACHE_SIGNING_KEY`; the cache public key string for Task 6.

- [ ] **Step 1: Create the bucket**

In the Backblaze console, create a **private** bucket named `spacefunk-nix-cache`. Do not reuse `spacefunk-mail-backups`: `ci/prune-cache.sh` deletes objects by default, and it must never be able to reach restic data.

Do **not** configure any lifecycle rule on this bucket.

- [ ] **Step 2: Create two bucket-scoped application keys**

Both restricted to `spacefunk-nix-cache` only.

| Key | Capabilities | Goes to |
|---|---|---|
| write key | `listFiles`, `readFiles`, `writeFiles`, `deleteFiles` | Actions secrets |
| read key | `listFiles`, `readFiles` | sops, Task 6 |

Record both `keyID` / `applicationKey` pairs. B2 shows the application key exactly once.

- [ ] **Step 3: Generate the cache signing keypair**

```bash
nix-store --generate-binary-cache-key spacefunk-nix-cache-1 /tmp/cache-key.sec /tmp/cache-key.pub
cat /tmp/cache-key.pub
```

Expected: a line of the form `spacefunk-nix-cache-1:<base64>`. Record it; Task 6 needs it verbatim.

- [ ] **Step 4: Add the Actions secrets**

In the nixcfg repository settings, add:

- `B2_CACHE_KEY_ID` — the write key's keyID
- `B2_CACHE_APP_KEY` — the write key's applicationKey
- `NIX_CACHE_SIGNING_KEY` — the full contents of `/tmp/cache-key.sec`

Then remove the private key from your machine:

```bash
shred -u /tmp/cache-key.sec
```

- [ ] **Step 5: Verify the bucket and write key work**

From any machine, using the **write** key:

```bash
export AWS_ACCESS_KEY_ID=<write keyID>
export AWS_SECRET_ACCESS_KEY=<write applicationKey>
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls s3://spacefunk-nix-cache/
```

Expected: exits 0, prints nothing (the bucket is empty).

If you get `InvalidAccessKeyId`, the region in the endpoint is wrong — confirm the S3 endpoint shown next to the bucket in the B2 console matches `s3.us-east-005.backblazeb2.com` exactly, and correct the Global Constraints value everywhere it appears if it does not.

- [ ] **Step 6: Verify the read key cannot write**

```bash
export AWS_ACCESS_KEY_ID=<read keyID>
export AWS_SECRET_ACCESS_KEY=<read applicationKey>
echo test > /tmp/canary
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 cp /tmp/canary s3://spacefunk-nix-cache/canary
```

Expected: **fails** with an access-denied error. A success here means the read key is over-scoped; recreate it with only `listFiles` and `readFiles`.

---

## Task 4: Push the signed closure and a manifest from CI

**Files:**
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: `packages.x86_64-linux.photoform` from Task 2; the Actions secrets from Task 3.
- Produces: bucket objects `nix-cache-info`, `<hash>.narinfo`, `nar/<...>`, and `manifests/<zero-padded-run-number>-<sha>.json` containing a JSON array of the closure's store paths.

Note the asymmetry, because it causes confusion later: `nix copy --to` is performed by the **client**, so environment variables on the workflow step are enough here. Substitution on vps is performed by the **daemon**, which is why Task 6 needs an `EnvironmentFile` instead.

- [ ] **Step 1: Add the push step**

In `.github/workflows/check.yml`, insert after the `nix flake check` step and **before** the existing `Advance verified` step:

```yaml
      # Runs before the ref advances so hosts never see a config whose closure
      # is not yet in the cache.
      - name: Push photoform to the binary cache
        if: github.event_name == 'push'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.B2_CACHE_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.B2_CACHE_APP_KEY }}
          CACHE_STORE: s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005
        run: |
          umask 077
          printf '%s' "${{ secrets.NIX_CACHE_SIGNING_KEY }}" > "$RUNNER_TEMP/cache-key.sec"
          nix copy --to "$CACHE_STORE&secret-key=$RUNNER_TEMP/cache-key.sec" .#photoform
          shred -u "$RUNNER_TEMP/cache-key.sec"

          # Retention is manifest-driven because nix copy skips paths already
          # present, so object timestamps do not track whether a path is live.
          nix path-info -r .#photoform | jq -R . | jq -s . > "$RUNNER_TEMP/manifest.json"
          nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
            s3 cp "$RUNNER_TEMP/manifest.json" \
            "s3://spacefunk-nix-cache/manifests/$(printf '%08d' "$GITHUB_RUN_NUMBER")-${GITHUB_SHA}.json"
```

The run number is zero-padded so that manifest keys sort lexicographically in run order, which `ci/prune-cache.sh` relies on in Task 5.

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/check.yml
git commit -m "ci(photoform): push the signed closure and a retention manifest to B2"
git push
```

- [ ] **Step 3: Verify on a push to main only**

Merge the branch to `main`, then, with the **read** key exported:

```bash
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls --recursive s3://spacefunk-nix-cache/
```

Expected: `nix-cache-info`, at least one `.narinfo`, at least one `nar/` object, and exactly one `manifests/00000001-<sha>.json`-style key.

- [ ] **Step 4: Verify a pull request does not write**

Open a trivial PR (a comment change is enough). When its run finishes, re-run the listing from Step 3.

Expected: **unchanged**. No new manifest. If a new manifest appeared, the `if: github.event_name == 'push'` guard is missing or misplaced.

- [ ] **Step 5: Verify the closure is signed**

```bash
nix path-info --store "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005" \
  --sigs $(nix eval --raw .#photoform)
```

Expected: output includes a `spacefunk-nix-cache-1:` signature. vps sets `require-sigs = true`, so an unsigned path would be rejected on arrival.

---

## Task 5: Prune the cache to the last two builds

**Files:**
- Create: `ci/prune-cache.sh`
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: manifests written by Task 4; `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the write key.
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
  s3 s3 cp "s3://$BUCKET/$hash.narinfo" - 2>/dev/null \
    | awk '/^URL: /{print $2}' >> "$work/objects-keep" || true
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

- [ ] **Step 2: Make it executable and commit it alone**

Committing the script before wiring it up keeps the reviewable unit small.

```bash
chmod +x ci/prune-cache.sh
git add ci/prune-cache.sh
git commit -m "ci(photoform): manifest-driven cache retention

Refuses to run with no manifests, since that would read as 'nothing is
referenced' and empty the bucket."
```

- [ ] **Step 3: Dry-run the script against the real bucket by hand**

With the **read** key exported (so a bug cannot delete anything), run the script and expect it to fail at the first delete:

```bash
export AWS_ACCESS_KEY_ID=<read keyID>
export AWS_SECRET_ACCESS_KEY=<read applicationKey>
export CACHE_BUCKET=spacefunk-nix-cache
export CACHE_ENDPOINT=https://s3.us-east-005.backblazeb2.com
nix shell nixpkgs#awscli2 nixpkgs#jq -c ./ci/prune-cache.sh
```

Expected with one manifest present: a line reading `prune-cache: keeping N, deleting 0`, and no delete attempted. `deleting 0` is the correct result — everything in the bucket is referenced by the only manifest.

If it reports a non-zero delete count at this stage, stop. Something in the bucket is unreferenced that should not be; inspect before granting the write key.

- [ ] **Step 4: Add the prune step to the workflow**

In `.github/workflows/check.yml`, add **after** the existing `Advance verified` step, as the last step in the job:

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

- [ ] **Step 5: Commit and merge to main**

```bash
git add .github/workflows/check.yml
git commit -m "ci(photoform): prune the cache after the ref advances"
git push
```

- [ ] **Step 6: Verify retention across three builds**

Pruning is only exercised on the third build, so all three are needed.

Push three commits to `main` that each change `photoform`'s `rev` to a different real commit of the private repo (three trivial commits in that repo will do). After the third run completes:

```bash
nix shell nixpkgs#awscli2 -c aws --endpoint-url https://s3.us-east-005.backblazeb2.com \
  s3 ls s3://spacefunk-nix-cache/manifests/
```

Expected: exactly **two** manifest objects, the two most recent. The third run's log should read `prune-cache: keeping N, deleting M` with `M` greater than zero.

---

## Task 6: Give vps the substituter and a read-only key

**Files:**
- Modify: `modules/system/nixos.nix`
- Modify: `secrets/hosts/vps.yaml`
- Modify: `hosts/vps/default.nix`

**Interfaces:**
- Consumes: the cache public key from Task 3 Step 3; the read key from Task 3 Step 2.
- Produces: `mine.system.privateCache.enable` and `mine.system.privateCache.credentialsFile`, enabled on vps.

- [ ] **Step 1: Add the option**

In `modules/system/nixos.nix`, inside `options.mine.system`, next to the existing `autoUpgrade.enable` declaration:

```nix
    privateCache = {
      enable = mkEnableOption "the private B2 binary cache as a substituter";

      credentialsFile = mkOption {
        type = types.path;
        description = ''
          Host path to an env file containing:
            AWS_ACCESS_KEY_ID=<B2 keyID>
            AWS_SECRET_ACCESS_KEY=<B2 applicationKey>
        '';
      };
    };
```

- [ ] **Step 2: Add the config block**

In the same file, add a new element to the existing `mkMerge` list, alongside the `mkIf cfg.autoUpgrade.enable` block:

```nix
    (mkIf cfg.privateCache.enable {
      nix.settings = {
        substituters = [
          "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005"
        ];
        trusted-public-keys = [
          "spacefunk-nix-cache-1:<public key from Task 3 Step 3>"
        ];
      };

      # Substitution is performed by the daemon, so the credentials have to be
      # in its environment rather than the caller's.
      systemd.services.nix-daemon.serviceConfig.EnvironmentFile =
        cfg.privateCache.credentialsFile;
    })
```

Substitute the real public key string recorded in Task 3. `substituters` and `trusted-public-keys` are list-typed options that merge, so `cache.nixos.org` and its key are retained.

- [ ] **Step 3: Add the secret**

```bash
nix shell nixpkgs#sops -c sops secrets/hosts/vps.yaml
```

Add a `nix-cache-b2-env` key whose value is a two-line block, matching the shape `restic-stalwart-b2-env` already uses in this file:

```yaml
nix-cache-b2-env: |
    AWS_ACCESS_KEY_ID=<read keyID>
    AWS_SECRET_ACCESS_KEY=<read applicationKey>
```

`.sops.yaml` already has a rule for `secrets/hosts/vps\.yaml$` encrypting to `waktu_redtruck`, `waktu_t495` and `host_vps`, so no change is needed there.

- [ ] **Step 4: Wire it up on vps**

In `hosts/vps/default.nix`, alongside the existing `sops.secrets` declarations:

```nix
  sops.secrets.nix-cache-b2-env = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
```

and inside `mine.system`, next to `autoUpgrade.enable = true;`:

```nix
      privateCache = {
        enable = true;
        credentialsFile = config.sops.secrets.nix-cache-b2-env.path;
      };
```

- [ ] **Step 5: Format and check**

```bash
nix fmt
nix flake check --print-build-logs
```

Expected: green, including `nixos-vps`.

- [ ] **Step 6: Confirm no other host changed**

```bash
for h in elitebook paynefield t495 redtruck; do
  echo -n "$h "
  nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"
  echo
done
```

Record these. Compare against the same command run on `main` before this task. Expected: identical. Only vps's drvPath should differ.

- [ ] **Step 7: Commit and deploy to vps**

```bash
git add modules/system/nixos.nix hosts/vps/default.nix secrets/hosts/vps.yaml
git commit -m "feat(vps): add the private B2 binary cache as a substituter

Substitution runs in the daemon, so the read-only B2 key is supplied via
nix-daemon's EnvironmentFile rather than the caller's environment."
git push
```

Merge to `main`, wait for `verified` to advance, then on vps:

```bash
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified
sudo systemctl restart nix-daemon
```

The explicit daemon restart is needed once: sops writes the secret during activation, and the already-running daemon will not pick up a new `EnvironmentFile` on its own.

---

## Task 7: Prove vps substitutes rather than builds

The end-to-end check. Nothing on vps references `photoform` yet — that is sub-project B — so this builds the flake output directly.

**Files:** none.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Confirm vps can read the bucket at all**

On vps, with the read key exported into your own shell — this tests the bucket and key, not the daemon:

```bash
set -a; source /run/secrets/nix-cache-b2-env; set +a
nix path-info --store "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005" \
  $(nix eval --raw github:BJSummerfield/nixcfg/verified#photoform)
```

Expected: the store path is printed. `AccessDenied` means the read key is wrong or the endpoint region is off.

- [ ] **Step 2: Confirm the daemon substitutes**

In a clean shell with **no** AWS variables set, so only the daemon's credentials are in play:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  nix build --no-link --print-build-logs github:BJSummerfield/nixcfg/verified#photoform
```

Expected: log lines reading `copying path '/nix/store/...-photoform-unstable' from 's3://spacefunk-nix-cache...'`.

**This is the success criterion for the whole plan.** If instead you see `building '/nix/store/...-photoform-unstable.drv'` or any Rust compilation output, the substituter is not being consulted — check that `nix show-config | grep substituters` on vps lists the s3 URL, and that `systemctl restart nix-daemon` was run after the secret appeared.

Be ready to interrupt: a compile here is the exact 1 GB OOM risk the design exists to avoid, and Stalwart shares that memory.

- [ ] **Step 3: Confirm vps holds no GitHub credential**

```bash
sudo grep -ri "NIX_GITHUB_PRIVATE" /etc/systemd/system/ /run/secrets/ 2>/dev/null; echo "exit: $?"
```

Expected: no matches.

- [ ] **Step 4: Record completion**

```bash
git commit --allow-empty -m "chore(photoform): binary cache verified end to end on vps

vps substitutes photoform from B2, holds no GitHub credential, and has
never compiled it."
git push
```

---

## Follow-ups deliberately not in this plan

- **Sub-project B** — the nspawn container, caddy on the host routing to it, PhotoForm's runtime secrets, and `mine.backups` registration. Needs its own spec. It is what first puts `photoform` into vps's closure, so Task 7 must pass before it lands.
- **PAT expiry** — a fine-grained token expires on a schedule. When it does, `nix flake check` fails, `verified` stops advancing, and elitebook and paynefield freeze alongside vps despite having nothing to do with this app. Set a calendar reminder for a week before expiry.
- **Caching `encode_queue`** — CI already builds it and it is only 47 MiB, so pushing it would save redtruck a Rust compile. Deliberately left out: redtruck does not auto-upgrade and the saving is small.
