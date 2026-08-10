# Stalwart webadmin wasm-bindgen Fix

## Problem

The `vps` host fails to build because the `stalwart` NixOS container cannot build
its `webadmin` admin UI. The Rust compilation succeeds, but `wasm-opt` (from
`binaryen-130`) rejects the wasm output with `[parse exception: duplicate export
name]`. This is a version mismatch: `wasm-bindgen-cli_0_2_93` emits duplicate
exports that newer `binaryen` refuses to parse.

The failure is in nixpkgs itself, not our config. The derivation
`vbg5v46lhln5y1680k1j0ys3czddxcys-webadmin-0.1.37.drv` fails identically on
any machine using the same nixpkgs lock.

## Root Cause

`stalwart_0_15.webadmin` (the admin UI, built as Rust→wasm via Trunk) depends on
`wasm-bindgen-cli_0_2_93`, pinned to match upstream's `Cargo.lock`. In nixpkgs
`f13ff45` (our locked `nixos-unstable`), `binaryen` is at version 130, which
strictly validates wasm modules and rejects the duplicate exports.

## Goal

Unblock the `vps` build with the smallest possible change that matches what
upstream nixpkgs already decided.

## Design

### 1. Container-scoped overlay with upstream wasm-bindgen patch

Add a `nixpkgs.overlays` inside `containers.stalwart.config` in
`modules/stalwart-server/nixos.nix`. The overlay overrides
`wasm-bindgen-cli_0_2_93` with a patch that fixes the duplicate exports, copied
verbatim from nixpkgs commit `bb15a89` (2026-08-08, "stalwart_0_15.webadmin:
fixes wasm-bindgen deplicate exports").

The patch applies wasm-bindgen PR #4380 to the pinned `wasm-bindgen-cli_0_2_93`,
so it stops emitting duplicate exports in the first place. This keeps `wasm-opt`
`-Oz` optimization intact (2.26 MB output vs 2.46 MB unoptimized).

Override the tool, not the consumer: `webadmin.nix` takes `wasm-bindgen-cli_0_2_93`
as a `callPackage` argument, so the patched tool flows in automatically. This
avoids touching the expensive `stalwart_0_15` Rust derivation itself.

The overlay must be inside the container config, not a host overlay. NixOS
containers evaluate their own nixpkgs via `eval-config.nix`
(`nixos-containers.nix:595-693`), so host overlays never propagate.

### 2. Explicit package pin

Add `services.stalwart.package = pkgs.stalwart_0_15;` to silence the
`warnAlias` warning ("`stalwart` is currently pinned to `0.15.5`...") and
prevent a silent major-version jump if nixpkgs ever repoints the alias.

`pkgs.stalwart` and `pkgs.stalwart_0_15` resolve to the identical derivation,
so this is a no-op today that buys forward compatibility.

### 3. Removal criteria

A comment documents: delete the overlay once `nixos-unstable` passes
2026-08-08 (commit `bb15a89`). Verify with `nix eval nixpkgs#stalwart_0_15.webadmin.drvPath`
after a channel bump — if it builds without the overlay, the fix is upstream.

## Scope

- **File:** `modules/stalwart-server/nixos.nix` only
- **Changes:** Container config overlay + explicit package pin
- **Out of scope:** `stalwart_0_16` migration (the module isn't compatible yet,
  separate UI app, separate data-format story)

## Verification

1. `nix build .#nixosConfigurations.vps.config.containers.stalwart.path` — must
   succeed (currently fails on `webadmin`)
2. Full `nix build .#nixosConfigurations.vps.config.system.build.toplevel`
3. Other five hosts still evaluate — overlay is container-scoped
4. Build on redtruck, not the 1 GB vps — release-mode Rust+wasm will OOM

## Alternatives Considered

- **B — Second nixpkgs input pinned at `bb15a89`:** No local patch to maintain,
  but drags in a full second nixpkgs snapshot. Contradicts existing practice of
  collapsing pins to avoid dead-weight fetches.
- **C — Wait for the channel:** `nixos-unstable` head is `f13ff45` (our exact
  lock), fix is 202 commits ahead on master. Blocks the vps indefinitely.
- **Fallback — Disable wasm-opt:** `data-wasm-opt="0"` one-liner, verified to
  build. Loses optimization, diverges from upstream. Escape hatch only.