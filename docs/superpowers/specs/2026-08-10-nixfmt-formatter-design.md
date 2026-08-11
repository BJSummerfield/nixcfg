# Nix Formatter: nixpkgs-fmt → nixfmt

## Problem

`nixpkgs-fmt` was archived in July 2024. Its README reads *"STATUS: archived.
Replaced by nixfmt."* It is the formatter this repo uses, and it is named in
exactly one place — `modules/helix/languages/nix.nix` — which makes it the de
facto standard for the tree without anything enforcing it.

Nothing does enforce it. There is no `formatter` flake output, so `nix fmt`
fails, and 16 of 138 `.nix` files currently fail `nixpkgs-fmt --check`.

The same helix module installs two nix language servers, `nil` and `nixd`.
Helix's built-in default for the `nix` language is `nil` and nothing selects
otherwise, so `nixd` is built and installed on every host that enables the
helix module and is never invoked.

## Goal

One formatter, declared in the flake, used by `nix fmt`, the devShell and
helix alike. The tree fully formatted so the declaration is true.

## Decisions

- **`pkgs.nixfmt`.** In the pinned nixpkgs (`f13ff45`) `nixfmt` and
  `nixfmt-rfc-style` both resolve to nixfmt 1.4.0, and `nixfmt-classic` has
  been removed. The unsuffixed attribute is correct and needs no alias.
- **Whole repo, one commit.** All 138 `.nix` files are in scope; 105 actually
  change, ~4000 lines. A formatter is all-or-nothing: leaving part of the tree
  unformatted means the diff reappears inside whatever branch next runs
  `nix fmt`.
- **Drop `nixd`, keep `nil`.** `nil` is what helix already uses, so editing
  behaviour is unchanged and an unused LSP stops being built.

## Scope

**In:**

- `flake.nix` — add the `formatter` output; add `nixfmt` to the devShell
- `modules/helix/languages/nix.nix` — retarget formatter and packages
- `.git-blame-ignore-revs` — new file
- Mechanical reformat of the tree

**Out:** treefmt-nix, a `checks.formatting` gate, CI, and statix/deadnix
enforcement. Those are separate work; this change only makes the formatter
coherent.

## Approach

Ordered so the reformat commit contains no logic:

1. **Logic commit.** `flake.nix` and the helix module, then `nix fmt` on just
   those two paths so step 2 does not touch them again and the logic diff
   stays readable.
2. **Reformat commit.** `nix fmt` over the repo, nothing else in the commit.
3. **Blame commit.** `.git-blame-ignore-revs` containing step 2's SHA. It has
   to be a third commit because the SHA does not exist until step 2 lands.

## Changes

### `flake.nix`

Add the output alongside `devShells`, using the existing `forAllSystems`:

```nix
formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
```

And add the binary to the devShell so direnv puts the declared formatter on
`$PATH`:

```nix
packages = with pkgs; [
  nixfmt
  sops
];
```

### `modules/helix/languages/nix.nix`

```nix
formatter = {
  command = "nixfmt";
};
```

```nix
extraPackages = with pkgs; [
  nil
  nixfmt
];
```

`auto-format = true` is unchanged, so saving a `.nix` file in helix runs
nixfmt.

### `.git-blame-ignore-revs`

```
# Repo-wide reformat, nixpkgs-fmt -> nixfmt. No logic changed.
<sha of the reformat commit>
```

GitHub honours this file automatically. Local `git blame` needs it enabled
once per clone, which cannot be committed:

```
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

That command belongs in the commit message of step 3, not in a module.

## Verification

- `nix fmt` succeeds, and a second run produces no diff (idempotent).
- The reformat commit touches ~105 files and no non-`.nix` file.
- `nix flake check` still passes — both `devboxes` and `redtruck-eval`.
- `rg nixpkgs-fmt` and `rg nixd` return nothing.
- The helix config actually changed, checked at eval rather than by reading:

```
nix eval .#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.languages.language
```

  The `nix` entry's `formatter.command` is `"nixfmt"`.

## Success Criteria

- `nix fmt` formats the repo and is idempotent.
- No reference to `nixpkgs-fmt` or `nixd` remains.
- `nix flake check` passes.
- The reformat is isolated in one commit that `git blame` skips.
