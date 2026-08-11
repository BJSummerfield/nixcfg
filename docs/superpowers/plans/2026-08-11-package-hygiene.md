# Package Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the repo's local package derivations from silently rotting, and give `mine.allowedUnfree` a single declaration.

**Architecture:** Five independent changes on one branch. The unfree option stops being hand-copied into the NixOS module. mpls drops its broken local derivation for the nixpkgs one. encode_queue's moving `rev = "main"` becomes a commit SHA. bicep is switched off on every host, taking a 712 MiB .NET SDK out of two closures. Finally `encode_queue` becomes a flake output that `nix flake check` actually builds — the only part that prevents recurrence.

**Tech Stack:** Nix flakes, home-manager, nixpkgs `f13ff45`.

## Global Constraints

- The repo is formatted with nixfmt. After editing any `.nix` file run `nix fmt`, and include the result in the same commit.
- `nix flake check` and host evaluations take several minutes on a cold store. Use a generous timeout (up to 1800000 ms) rather than killing and retrying.
- End every commit message with a blank line then: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Do **not** add `bicep-langserver` to `packages` or to `checks`. No host enables it and its dotnet SDK dependency is a 712.5 MiB closure.
- Do **not** delete `modules/bicep-langserver/` or `modules/helix/languages/bicep.nix`. The module stays so re-enabling is one line per host.
- Tasks run in order. Task 1's assertion compares a derivation hash that later tasks deliberately change.
- **Do not push.** This branch stacks on the CI-gate work, which carries `.github/workflows/check.yml`, and the token authenticating `gh` lacks the `workflow` scope — pushes are rejected. Commit locally and stop there; publication is the human's to unblock.

---

### Task 1: Give `mine.allowedUnfree` one declaration

**Files:**
- Modify: `modules/unfree/nixos.nix` (whole file, 12 lines)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `options.mine.allowedUnfree` keeps the same name, type (`listOf str`) and default (`[ ]`); only the declaration's location changes.

- [ ] **Step 1: Record the two values this change must not alter**

```bash
nix eval --json '.#nixosConfigurations.redtruck.config.mine.allowedUnfree'
nix eval --raw '.#nixosConfigurations.redtruck.config.system.build.toplevel.drvPath'
```
Expected: a JSON list beginning `["1password","1password-cli",…]`, and the path
`/nix/store/ngqq8dis1f50864bki6c7g0x7nvbbs5k-nixos-system-redtruck-26.11.20260807.f13ff45.drv`.
Save both — Step 3 compares against them.

- [ ] **Step 2: Replace the file**

`modules/unfree/nixos.nix` currently declares the option itself. Replace its entire contents with:

```nix
{ lib, config, ... }:
{
  imports = [ ./options.nix ];

  config.nixpkgs.config.allowUnfreePredicate =
    pkg: builtins.elem (lib.getName pkg) config.mine.allowedUnfree;
}
```

This makes it structurally identical to `modules/unfree/darwin.nix`. The shared declaration in `modules/unfree/options.nix` is unchanged, and already carries the better description.

- [ ] **Step 3: Verify nothing moved**

```bash
nix eval --json '.#nixosConfigurations.redtruck.config.mine.allowedUnfree'
nix eval --raw '.#nixosConfigurations.redtruck.config.system.build.toplevel.drvPath'
```
Expected: byte-identical to Step 1, including the same `ngqq8dis…` derivation hash. A different hash means the change was not behaviour-neutral — stop and investigate.

- [ ] **Step 4: Verify there is now exactly one declaration**

```bash
rg -n 'options.mine.allowedUnfree' --glob '*.nix'
```
Expected: one line only, `modules/unfree/options.nix:3`.

- [ ] **Step 5: Verify checks still pass**

```bash
nix flake check
```
Expected: `all checks passed!`

- [ ] **Step 6: Format and commit**

```bash
nix fmt
git add modules/unfree/nixos.nix
git commit -m "refactor(unfree): declare allowedUnfree once

nixos.nix hand-copied the declaration that options.nix already holds and
home.nix and darwin.nix both import, with a weaker description. The two
copies had already drifted. Behaviour-neutral: redtruck's toplevel
derivation hash is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Take mpls from nixpkgs

**Files:**
- Delete: `modules/mpls/package.nix`
- Modify: `modules/mpls/home.nix:21`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.mine.user.mpls.package` now defaults to `pkgs.mpls` (version 0.21.3). `modules/helix/languages/markdown.nix:19` consumes it as `${mplsModule.package}/bin/mpls` and must keep working — `pkgs.mpls`'s `mainProgram` is `mpls`, so it does.

- [ ] **Step 1: Record what mpls resolves to today**

```bash
nix eval --raw '.#nixosConfigurations.t495.config.home-manager.users.waktu.programs.helix.languages.language-server.mpls.command'
```
Expected: a path ending `-mpls-unstable/bin/mpls` — the local derivation.

- [ ] **Step 2: Change the default to the nixpkgs package**

In `modules/mpls/home.nix`, line 21 currently reads:

```nix
      default = pkgs.callPackage ./package.nix { };
```

Change it to:

```nix
      default = pkgs.mpls;
```

- [ ] **Step 3: Delete the local derivation**

```bash
git rm modules/mpls/package.nix
```

- [ ] **Step 4: Verify mpls now comes from nixpkgs**

```bash
nix eval --raw '.#nixosConfigurations.t495.config.home-manager.users.waktu.programs.helix.languages.language-server.mpls.command'
```
Expected: a path containing `mpls-0.21.3` and ending `/bin/mpls`.

- [ ] **Step 5: Verify it actually builds — this is the point of the task**

The old derivation could not be built from a cold store; the new one must be.

```bash
nix build --no-link --print-out-paths '.#nixosConfigurations.t495.config.mine.user.mpls.package'
```
Expected: a store path ending `-mpls-0.21.3`.

- [ ] **Step 6: Verify checks still pass**

```bash
nix flake check
```
Expected: `all checks passed!`

- [ ] **Step 7: Format and commit**

```bash
nix fmt
git add modules/mpls/home.nix modules/mpls/package.nix
git commit -m "fix(mpls): take the package from nixpkgs

The local derivation fetched rev = \"main\" against a fixed hash. Upstream
moved on 2026-08-05, so the hash no longer matched and mpls could not be
built from a cold store - it only worked where it was already realised.
nixpkgs ships mpls 0.21.3 with mainProgram mpls, so the helix markdown
language server keeps working unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Pin encode_queue to a commit

**Files:**
- Modify: `modules/encode_queue/package.nix:9`

**Interfaces:**
- Consumes: nothing.
- Produces: a `modules/encode_queue/package.nix` that fetches a fixed commit. Task 5 exposes this same file as `packages.<system>.encode_queue`.

- [ ] **Step 1: Confirm the recorded hash still matches upstream**

```bash
nix flake prefetch --json github:BJSummerfield/encode_queue/a15d41a8ef1c1a0c21a9a6555b4183ec372289fe
```
Expected: the `hash` field is `sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=`, matching the `sha256` already in the file. That is why this pin rebuilds nothing.

- [ ] **Step 2: Replace the moving ref**

In `modules/encode_queue/package.nix`, line 9 currently reads:

```nix
    rev = "main";
```

Change it to:

```nix
    rev = "a15d41a8ef1c1a0c21a9a6555b4183ec372289fe";
```

Leave `sha256` and `cargoHash` exactly as they are.

- [ ] **Step 3: Verify no moving refs remain anywhere**

```bash
rg -n 'rev = "(main|master|HEAD)"' --glob '*.nix'
```
Expected: no output. (`modules/mpls/package.nix` was deleted in Task 2, so this should now be clean.)

- [ ] **Step 4: Verify it builds**

```bash
nix build --no-link --print-out-paths '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.mine.user.encode_queue.package'
```
Expected: a store path ending `-encode_queue-unstable`. Note the path goes
through `home-manager.users.waktu` — `mine.user.*` options live in the
home-manager module tree, not at the top level of the NixOS config.

- [ ] **Step 5: Verify checks still pass**

```bash
nix flake check
```
Expected: `all checks passed!`

- [ ] **Step 6: Format and commit**

```bash
nix fmt
git add modules/encode_queue/package.nix
git commit -m "fix(encode_queue): pin to a commit instead of main

A fixed hash against a moving ref is only reproducible until upstream
moves. Upstream has not moved since 2024, so the recorded hash still
matches this commit and nothing rebuilds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Turn bicep off on every host

**Files:**
- Modify: `hosts/redtruck/default.nix:151`
- Modify: `hosts/mac/default.nix:62`
- Modify: `hosts/vm-mac/default.nix:39`

**Interfaces:**
- Consumes: nothing.
- Produces: no host sets `mine.user.helix.lsp.bicep.enable`. `modules/bicep-langserver/` and `modules/helix/languages/bicep.nix` remain in the tree, unreferenced by any host.

- [ ] **Step 1: Confirm the .NET SDK is currently in redtruck's closure**

```bash
nix-store -q --requisites "$(nix eval --raw '.#nixosConfigurations.redtruck.config.system.build.toplevel.drvPath')" | grep -c -E 'dotnet|bicep'
```
Expected: a non-zero count.

- [ ] **Step 2: Remove the three enables**

Delete the line `bicep.enable = true;` from each of these files. It appears once in each, inside a `helix.lsp` block:

- `hosts/redtruck/default.nix:151`
- `hosts/mac/default.nix:62`
- `hosts/vm-mac/default.nix:39`

Delete only that line. Leave the surrounding `lsp` block and every other language entry untouched. Do not touch `modules/bicep-langserver/` or `modules/helix/languages/bicep.nix`.

- [ ] **Step 3: Verify no host enables bicep**

```bash
rg -n 'bicep.enable' hosts/
```
Expected: no output.

- [ ] **Step 4: Verify the SDK left redtruck's closure**

```bash
nix-store -q --requisites "$(nix eval --raw '.#nixosConfigurations.redtruck.config.system.build.toplevel.drvPath')" | grep -c -E 'dotnet|bicep'
```
Expected: `0`.

- [ ] **Step 5: Verify the module still evaluates while disabled**

The module stays in the tree, so it must still evaluate cleanly with `enable = false`:

```bash
nix flake check
```
Expected: `all checks passed!`

- [ ] **Step 6: Format and commit**

```bash
nix fmt
git add hosts/redtruck/default.nix hosts/mac/default.nix hosts/vm-mac/default.nix
git commit -m "chore(bicep): disable the language server on all hosts

Its wrapper references dotnetCorePackages.dotnet_8.sdk, giving it a
712.5 MiB closure, and nothing else in the repo needs dotnet. Drops the
SDK from redtruck and mac. The module stays so re-enabling is one line.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Expose encode_queue and make CI build it

**Files:**
- Modify: `flake.nix` — add a `packages` output after `formatter` (currently line 74); extend the `checks.x86_64-linux` expression (currently ends line 103)

**Interfaces:**
- Consumes: `modules/encode_queue/package.nix` as pinned in Task 3.
- Produces: `packages.<system>.encode_queue` for all three systems in `systems`, and a `checks.x86_64-linux.pkg-encode_queue` that genuinely builds it.

- [ ] **Step 1: Record the current check set**

```bash
nix eval --json --apply 'builtins.attrNames' '.#checks.x86_64-linux'
```
Expected exactly:
```
["darwin-mac","devboxes","nixos-elitebook","nixos-paynefield","nixos-redtruck","nixos-t495","nixos-vps"]
```

- [ ] **Step 2: Add the packages output**

In `flake.nix`, immediately after the `formatter = …;` line, add a blank line then:

```nix
      # Exposed so `nix build .#encode_queue` works and so the checks below
      # build it. bicep-langserver is deliberately absent: no host enables it
      # and its dotnet SDK dependency is a 712 MiB closure.
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

- [ ] **Step 3: Extend the checks expression**

The `checks.x86_64-linux` expression currently ends with the `devboxes` attribute set and a `;`:

```nix
        // {
          devboxes = import ./tests/devboxes.nix {
            inherit nixpkgs inputs;
            system = "x86_64-linux";
          };
        };
```

Replace that trailing `};` so the chain continues — note the `}` and `;` are now separated by the new clause:

```nix
        // {
          devboxes = import ./tests/devboxes.nix {
            inherit nixpkgs inputs;
            system = "x86_64-linux";
          };
        }
        # Unlike the eval-only checks above, these really build. A package
        # added later is covered without anyone wiring it up.
        // nixpkgs.lib.mapAttrs' (
          name: drv: nixpkgs.lib.nameValuePair "pkg-${name}" drv
        ) inputs.self.packages.x86_64-linux;
```

- [ ] **Step 4: Verify the package output is reachable**

```bash
nix build --no-link --print-out-paths '.#encode_queue'
```
Expected: a store path ending `-encode_queue-unstable`.

- [ ] **Step 5: Verify the check set gained exactly one entry**

```bash
nix eval --json --apply 'builtins.attrNames' '.#checks.x86_64-linux'
```
Expected exactly:
```
["darwin-mac","devboxes","nixos-elitebook","nixos-paynefield","nixos-redtruck","nixos-t495","nixos-vps","pkg-encode_queue"]
```
There must be no `pkg-bicep-langserver`.

- [ ] **Step 6: Verify the whole check set passes**

```bash
nix flake check
```
Expected: `all checks passed!` — and unlike before, this run genuinely builds `encode_queue` rather than only evaluating it.

- [ ] **Step 7: Format and commit**

```bash
nix fmt
git add flake.nix
git commit -m "feat(ci): build local packages in nix flake check

The gate evaluates rather than builds, which is how mpls's broken hash
went unnoticed. encode_queue is now a flake output and a check that
really builds, so the same rot fails CI instead of a host at 04:00.
Generated from packages, so a package added later is covered too.

bicep-langserver is deliberately excluded: no host enables it and its
dotnet SDK dependency is a 712.5 MiB closure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Confirm the whole change holds together

**Files:** none — verification only.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: No moving refs, one unfree declaration, no host bicep**

```bash
rg -n 'rev = "(main|master|HEAD)"' --glob '*.nix' ; echo "moving refs: $?"
rg -c 'options.mine.allowedUnfree' --glob '*.nix'
rg -n 'bicep.enable' hosts/ ; echo "host bicep: $?"
```
Expected: `moving refs: 1` (no matches), a single file reporting `1`, and `host bicep: 1` (no matches).

- [ ] **Step 2: The bicep module is still present and untouched**

```bash
ls modules/bicep-langserver/home.nix modules/bicep-langserver/package.nix modules/helix/languages/bicep.nix
rg -c 'mkIf cfg.enable' modules/helix/languages/bicep.nix
```
Expected: all three files exist, and the module still gates its config on `mkIf cfg.enable` (count `1`). Task 4 disabled bicep at the hosts without touching the module.

- [ ] **Step 3: No host closure carries the .NET SDK**

```bash
for h in redtruck t495 elitebook paynefield vps; do
  printf "%-11s " "$h"
  nix-store -q --requisites "$(nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath")" | grep -c -E 'dotnet|bicep'
done
```
Expected: `0` for every host.

- [ ] **Step 4: Everything passes, and packages really build**

```bash
nix flake check
nix build --no-link --print-out-paths '.#encode_queue'
```
Expected: `all checks passed!`, then a store path ending `-encode_queue-unstable`.

- [ ] **Step 5: The tree is clean and formatted**

```bash
nix fmt
git status --porcelain
```
Expected: `0 changed` from `nix fmt`, and no output from `git status`.

No commit — this task changes nothing.
