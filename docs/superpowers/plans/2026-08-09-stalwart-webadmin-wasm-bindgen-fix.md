# Stalwart webadmin wasm-bindgen Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `vps` build by patching `wasm-bindgen-cli_0_2_93` inside the Stalwart container so `webadmin` compiles without `wasm-opt` duplicate-export errors.

**Architecture:** Container-scoped `nixpkgs.overlays` in `modules/stalwart-server/nixos.nix` that overrides `wasm-bindgen-cli_0_2_93` with the upstream wasm-bindgen PR #4380 fix (nixpkgs commit `bb15a89`). The patch is applied to the vendored `cli-support` crate via `postPatch` in the override. Also pin `services.stalwart.package` explicitly to silence the `warnAlias`.

**Tech Stack:** Nix, NixOS containers, `fetchpatch`, `overrideAttrs`

## Global Constraints

- Overlay must be inside `containers.stalwart.config`, not a host overlay (containers evaluate their own nixpkgs)
- Patch is copied verbatim from nixpkgs `bb15a89` — same `fetchpatch` URL, same hash, same `postPatch` command
- Build on redtruck, not the 1 GB vps (Rust+wasm will OOM)
- When `nixos-unstable` passes 2026-08-08, the overlay becomes a no-op and should be deleted

---

### Task 1: Add container-scoped wasm-bindgen patch and explicit package pin

**Files:**
- Modify: `modules/stalwart-server/nixos.nix`

**Interfaces:**
- Consumes: none
- Produces: patched `wasm-bindgen-cli_0_2_93` in the container's nixpkgs, explicit `stalwart_0_15` package pin

- [ ] **Step 1: Read the current file and identify insertion points**

Read `modules/stalwart-server/nixos.nix` and locate:
1. The top-level `{ lib, config, pkgs, ... }` argument list (line 19) — need to add `fetchpatch`
2. The `containers.stalwart.config = { config, pkgs, lib, ... }: {` block — need to add `nixpkgs.overlays` inside it
3. The `services.stalwart = {` block (inside container config) — need to add `package` attribute

- [ ] **Step 2: Add `fetchpatch` to the module argument set**

Change line 19 from:
```nix
{ lib, config, pkgs, ... }:
```
to:
```nix
{ lib, config, pkgs, fetchpatch, ... }:
```

- [ ] **Step 3: Add the patched wasm-bindgen and container-scoped overlay**

The patched package must be defined at the TOP-LEVEL of the module (where `pkgs` has full access to `wasm-bindgen-cli_0_2_93`), then passed into the container config via the overlay. The container's `pkgs` is evaluated by `evalModules`/`eval-config.nix` and may not expose all by-name attrs.

Add `fetchpatch` to the top-level argument list (done in Step 2), then add a `let` block after the existing `let` block at the top of the module.

After the existing `let` block that defines `cfg` and `hostStateDir`, add the patched wasm-bindgen definition:

```nix
{ lib, config, pkgs, fetchpatch, ... }:
let
  cfg = config.mine.system.stalwart-server;
  hostStateDir = "/var/lib/stalwart-data";

  # nixpkgs f13ff45: wasm-bindgen-cli_0_2_93 emits duplicate exports
  # that binaryen-130 refuses to parse. Patch with wasm-bindgen PR #4380
  # (nixpkgs bb15a89, 2026-08-08). Delete this overlay once nixos-unstable
  # passes that commit — verify with: nix eval nixpkgs#stalwart_0_15.webadmin.drvPath
  wasmBindgenCliDedupExportsPatch = fetchpatch {
    url = "https://github.com/wasm-bindgen/wasm-bindgen/commit/b375e974cf30a203f1ea7f6320ad32759c5cb9e6.patch";
    relative = "crates/cli-support";
    hash = "sha256-pejDKqNbtlpLLqNcdpwgxDSxsGxyv5V8/QeK+OCY3qw=";
  };
  wasmBindgenCliPatched = pkgs.wasm-bindgen-cli_0_2_93.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      patch -p1 -d "$cargoDepsCopy"/*/wasm-bindgen-cli-support-* < ${wasmBindgenCliDedupExportsPatch}
    '';
  });
in
{```

Then inside `containers.stalwart.config`, add the overlay that uses the top-level binding:

```nix
      config = { config, pkgs, lib, ... }: {
        nixpkgs.overlays = [
          (final: prev: {
            wasm-bindgen-cli_0_2_93 = wasmBindgenCliPatched;
          })
        ];

        systemd.services.stalwart.serviceConfig.LoadCredential = [
```

And inside `services.stalwart = {`, add the explicit package pin:
```nix
        services.stalwart = {
          enable = true;
          package = pkgs.stalwart_0_15;
          openFirewall = false;
```

- [ ] **Step 4: Verify the file parses (eval only)**

```bash
nix eval --no-write-lock-file '.#nixosConfigurations.vps.config.system.build.toplevel.drvPath' 2>&1 | tail -3
```

Expected: resolves to a derivation path (e.g. `/nix/store/...-nixos-system-vps-26.11...drv`). The overlay is only exercised at build time, so eval should succeed even though the container hasn't been built yet.

- [ ] **Step 5: Build the stalwart container path**

```bash
nix build --no-link --print-out-paths --no-write-lock-file -L '.#nixosConfigurations.vps.config.containers.stalwart.path' 2>&1 | tee /tmp/stalwart-build.log
```

Expected: success, producing a `nixos-system-stalwart-*.drv` output. The `webadmin` derivation should build with the patched wasm-bindgen and `wasm-opt -Oz` should succeed.

If this fails, check `/tmp/stalwart-build.log` for the specific error. Common issues:
- `pkgs.wasm-bindgen-cli_0_2_93` not found at top level — unlikely, but means the by-name overlay isn't active
- Patch doesn't apply — `fetchpatch` hash mismatch; re-compute with `nix-prefetch-url --type sha256`
- Still hits duplicate export — patch didn't land in the right vendored directory

- [ ] **Step 6: Build the full vps toplevel**

```bash
nix build --no-link --print-out-paths --no-write-lock-file -L '.#nixosConfigurations.vps.config.system.build.toplevel' 2>&1 | tail -10
```

Expected: success, producing `nixos-system-vps-26.11...drv`.

- [ ] **Step 7: Verify other hosts still evaluate**

```bash
for host in redtruck macbook vm-mac vm-win; do
  echo -n "$host: "
  nix eval --no-write-lock-file ".#nixosConfigurations.$host.config.system.build.toplevel.drvPath" 2>&1 | tail -1
done
```

Expected: all resolve to derivation paths without error.

- [ ] **Step 8: Commit**

```bash
git add modules/stalwart-server/nixos.nix
git commit -m 'fix(stalwart): patch wasm-bindgen to fix duplicate exports

nixpkgs f13ff45: wasm-bindgen-cli_0_2_93 emits duplicate exports that
binaryen-130 refuses to parse. Apply wasm-bindgen PR #4380 (nixpkgs
bb15a89) as a container-scoped overlay.

Also pin services.stalwart.package to stalwart_0_15 explicitly to
silence the warnAlias and prevent silent version jumps.

Removal: delete overlay once nixos-unstable passes 2026-08-08.'
```