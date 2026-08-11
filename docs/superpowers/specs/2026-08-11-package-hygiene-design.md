# Package hygiene: stop the local derivations rotting

## Problem

`modules/mpls/package.nix` fetches `rev = "main"` and checks it against a
fixed hash. Upstream moved on 2026-08-05, so the two no longer agree:

| Package | Recorded hash | Hash of `main` today |
|---|---|---|
| `encode_queue` | `sha256-jUDG5pjk…` | `sha256-jUDG5pjk…` (matches) |
| `mpls` | `sha256-ChEZigLK…` | `sha256-26WRMprK…` (differs) |

**mpls therefore cannot be built from a cold store.** It succeeds today only
because it is already realised locally. `modules/helix/languages/markdown.nix:19`
pulls it in for anyone with the markdown LSP enabled — redtruck and t495 —
so a new machine, a store GC, or CI would hit the mismatch.

The CI gate added earlier cannot catch this: it evaluates rather than builds,
and a fixed-output hash mismatch only surfaces at build time.

Separately, `options.mine.allowedUnfree` is declared twice — in
`modules/unfree/options.nix:3` and again in `modules/unfree/nixos.nix:3` with
a weaker description. `home.nix` and `darwin.nix` both import the shared file;
`nixos.nix` hand-copies it instead.

## Goal

No local derivation can silently rot, and the unfree option has one
declaration.

## Decisions

- **mpls comes from nixpkgs.** nixpkgs ships `mpls` 0.21.3 and its
  `mainProgram` is `mpls`, so `${mplsModule.package}/bin/mpls` keeps working.
  Deleting the local derivation removes the broken pin rather than repairing
  it, and hands future updates to nixpkgs. Cost: 0.22.0 → 0.21.3.
- **encode_queue is pinned to a commit.**
  `a15d41a8ef1c1a0c21a9a6555b4183ec372289fe`. Upstream has not moved since
  2024, so the recorded hash still matches and nothing rebuilds.
- **bicep is disabled on every host, and its module is kept.** The language
  server's wrapper references `dotnetCorePackages.dotnet_8.sdk`, giving it a
  712.5 MiB closure, and nothing else in the repo references dotnet. Turning
  it off removes `dotnet-sdk-8.0.128`, `dotnet-sdk-wrapped-8.0.129` and
  `dotnet-runtime-9.0.18` from redtruck's and mac's closures. The module and
  its derivation stay in the tree so re-enabling is one line per host.
- **`bicep-langserver` is not exposed as a package and not built in CI.** No
  host enables it, so building it would spend the 712.5 MiB this change
  exists to save. It also has no moving ref to guard — it fetches a tagged
  release zip — so the check would buy little. If it is ever re-enabled, add
  it to `packages` then.
- **`encode_queue` becomes a flake output, and CI builds it.** This is the
  change that prevents recurrence of the mpls failure.
- **Home modules keep their own `callPackage`.** Threading `inputs.self` into
  them would couple them to the flake, and they are also evaluated inside the
  devbox containers. Two call sites of one definition file is the cheaper
  trade.

## Scope

**In:**

- `modules/unfree/nixos.nix` — import the shared option declaration
- `modules/mpls/package.nix` — delete
- `modules/mpls/home.nix` — default to `pkgs.mpls`
- `modules/encode_queue/package.nix` — pin `rev`
- `hosts/redtruck/default.nix:151`, `hosts/mac/default.nix:62`,
  `hosts/vm-mac/default.nix:39` — drop `bicep.enable = true`
- `flake.nix` — add `packages`, extend `checks` to build them

**Out:** overlays, `nixosModules`/`homeModules` outputs, the deadnix/statix
cleanup, `flake.nix` boilerplate, the manual import lists, and the module
contract doc.

## Approach

### Unfree deduplication

`modules/unfree/nixos.nix` becomes structurally identical to `darwin.nix`:

```nix
{ lib, config, ... }:
{
  imports = [ ./options.nix ];

  config.nixpkgs.config.allowUnfreePredicate =
    pkg: builtins.elem (lib.getName pkg) config.mine.allowedUnfree;
}
```

Verified behaviour-neutral before writing this spec: the resolved
`mine.allowedUnfree` list is identical, redtruck's `toplevel` derivation hash
is unchanged (`ngqq8dis1f50864bki6c7g0x7nvbbs5k`), and `nix flake check`
passes.

### mpls

Delete `modules/mpls/package.nix`. In `modules/mpls/home.nix`, the `package`
option's default becomes `pkgs.mpls`. Nothing else changes —
`markdown.nix` consumes `mplsModule.package`, which is unaffected.

### encode_queue

```nix
    rev = "a15d41a8ef1c1a0c21a9a6555b4183ec372289fe";
```

`sha256` and `cargoHash` stay as they are.

### Flake outputs

```nix
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          encode_queue = pkgs.callPackage ./modules/encode_queue/package.nix { };
        }
      );
```

`bicep-langserver` is deliberately absent — see Decisions.

### Disabling bicep

Remove the `bicep.enable = true;` line from each of the three host files.
Nothing else changes: `modules/helix/languages/bicep.nix` gates all its
config behind `mkIf cfg.enable`, so a disabled instance contributes nothing.

### Package checks

Appended to the existing generated `checks.x86_64-linux`:

```nix
        // nixpkgs.lib.mapAttrs' (
          name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
        ) inputs.self.packages.x86_64-linux
```

A package added later is built by CI without anyone wiring it up.

**This deliberately crosses the CI gate's "evaluate, do not build" rule.**
That rule exists because building five NixOS closures is too heavy for a
GitHub runner. Two small packages are not. This is the narrow exception that
closes the hole mpls fell through, and it is intentional rather than an
oversight.

**Cost, measured:** `encode_queue` builds on `x86_64-linux` with a 47.2 MiB
closure — a substitution rather than a compile, and negligible on a runner
with ~14 GB free. `bicep-langserver` was measured at 712.5 MiB and is
excluded for that reason.

## Dependency on the CI-gate branch

The package-checks change extends the generated `checks` block introduced by
the CI gate, so this work stacks on that branch rather than on `main`.

That branch contains `.github/workflows/check.yml`, and the token currently
authenticating `gh` lacks the `workflow` scope, so **neither branch can be
pushed until that scope is granted**. The work can be completed and verified
locally regardless; only publication is blocked.

## Verification

- `nix eval --json '.#nixosConfigurations.redtruck.config.mine.allowedUnfree'`
  is unchanged by the unfree edit.
- redtruck's `toplevel` drvPath is unchanged by the unfree edit.
- `nix build .#encode_queue` succeeds.
- `nix eval --json --apply 'builtins.attrNames' '.#checks.x86_64-linux'`
  returns the previous seven plus `pkg-encode_queue` — eight in total, with
  no `pkg-bicep-langserver`.
- `nix flake check` passes, and now genuinely builds `encode_queue`.
- redtruck's and mac's closures no longer contain any `dotnet-sdk` or
  `dotnet-runtime` path, and no `bicep-langserver` path.
- `rg 'rev = "(main|master|HEAD)"' --glob '*.nix'` returns nothing.
- `rg 'options.mine.allowedUnfree'` returns exactly one declaration.
- t495 still resolves an mpls binary: its helix `language-server.mpls.command`
  ends in `/bin/mpls` and points into a `mpls-0.21.3` store path.

## Success Criteria

- No `.nix` file fetches a moving git ref.
- `mine.allowedUnfree` is declared once.
- `nix flake check` builds every local package that a host actually uses.
- mpls still works on the hosts that use it, sourced from nixpkgs.
- No host closure carries the .NET SDK.
