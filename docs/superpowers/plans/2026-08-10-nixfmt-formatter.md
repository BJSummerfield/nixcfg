# nixfmt Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the archived `nixpkgs-fmt` with `nixfmt` as this repo's one declared Nix formatter, wired into the flake, the devShell and helix, with the tree reformatted to match.

**Architecture:** Three sequential commits. The first changes logic only (`flake.nix` gains a `formatter` output and a devShell package; the helix module retargets its formatter and drops an unused LSP), written in the tree's existing style so the diff stays readable. The second is a pure mechanical `nix fmt` over the whole repo. The third records the reformat's SHA in `.git-blame-ignore-revs`, which is only possible once that SHA exists.

**Tech Stack:** Nix flakes, home-manager, nixfmt 1.4.0 (`pkgs.nixfmt` in the pinned nixpkgs), helix.

## Global Constraints

- Use the attribute `pkgs.nixfmt`. In the pinned nixpkgs (`f13ff45`) it resolves to nixfmt 1.4.0, identically to `nixfmt-rfc-style`. Do **not** write `nixfmt-rfc-style`, and do **not** write `nixfmt-classic` — that attribute has been removed from nixpkgs and evaluating it is a hard error.
- The formatter binary is named `nixfmt`.
- Task 1 must leave its two edited files in the tree's **current** (nixpkgs-fmt) style. Do not run `nix fmt` during Task 1.
- Task 2's commit must contain only formatting changes and touch only `.nix` files.
- Every `nix eval` / `nix fmt` command below is run from the repo root.
- Evaluating `nixosConfigurations.redtruck` takes a while on a cold store. Commands that look hung usually are not; give them several minutes.

---

### Task 1: Declare nixfmt in the flake and retarget helix

**Files:**
- Modify: `flake.nix:51-59` (devShells block; `formatter` output added after it)
- Modify: `modules/helix/languages/nix.nix:14-24`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a `formatter.<system>` flake output for all three systems in `systems` (`x86_64-linux`, `aarch64-linux`, `aarch64-darwin`), which Task 2 invokes as `nix fmt`.

- [ ] **Step 1: Confirm the two failing assertions**

The repo has no test runner; these two commands are the tests. Run both and record that they fail in the expected way.

```bash
nix fmt
```
Expected: `error: flake 'git+file://...' does not provide attribute 'formatter.x86_64-linux'`

```bash
nix eval --raw \
  --apply 'ls: (builtins.head (builtins.filter (l: l.name == "nix") ls)).formatter.command' \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.languages.language'
```
Expected: prints `nixpkgs-fmt`

- [ ] **Step 2: Add the formatter output and devShell package to `flake.nix`**

Replace the existing `devShells` block (lines 51-59) with this. Note `nixfmt` added to `packages`, and the new `formatter` output following the block. Keep the surrounding style exactly as shown — this file is deliberately not reformatted until Task 2.

```nix
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixfmt
              sops
            ];
          };
        });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
```

- [ ] **Step 3: Verify `nix fmt` now resolves**

```bash
nix fmt -- --version
```
Expected: prints a nixfmt version (`1.4.0`). The `--` passes the flag through to nixfmt rather than to `nix`.

- [ ] **Step 4: Retarget the helix nix module**

In `modules/helix/languages/nix.nix`, change the formatter command and the package list. Replace lines 14-24 with:

```nix
          formatter = {
            command = "nixfmt";
          };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        nil
        nixfmt
      ];
```

That drops `nixpkgs-fmt` (archived) and `nixd`. `nixd` is removed because helix's built-in default language server for `nix` is `nil` and nothing in this repo selects otherwise, so `nixd` was built and installed on every host without ever being invoked. Leave `auto-format = true` as-is.

- [ ] **Step 5: Verify both assertions now pass**

```bash
nix eval --raw \
  --apply 'ls: (builtins.head (builtins.filter (l: l.name == "nix") ls)).formatter.command' \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.languages.language'
```
Expected: prints `nixfmt`

```bash
nix eval --json --apply 'map (p: p.name)' \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.extraPackages'
```
Expected: the list contains `nil-2026-07-23` and a `nixfmt-1.4.0`, and contains **no** entry starting with `nixd-` or `nixpkgs-fmt-`.

- [ ] **Step 6: Verify the existing checks still pass**

```bash
nix flake check
```
Expected: succeeds. This runs the repo's two existing checks, `devboxes` and `redtruck-eval`.

- [ ] **Step 7: Commit**

```bash
git add flake.nix modules/helix/languages/nix.nix
git commit -m "feat(nix): declare nixfmt as the repo formatter

nixpkgs-fmt was archived in July 2024 and replaced by nixfmt, which is
now the official formatter under the NixOS org. Adds a formatter output
so nix fmt works, puts the binary in the devShell, and points helix at
it. Drops nixd, which was installed on every host but never invoked -
helix defaults to nil for nix and nothing selected otherwise."
```

---

### Task 2: Reformat the tree

**Files:**
- Modify: every `.nix` file nixfmt changes (expect ~105 of 138, ~4000 lines)

**Interfaces:**
- Consumes: the `formatter.<system>` output from Task 1.
- Produces: the commit SHA that Task 3 records in `.git-blame-ignore-revs`.

- [ ] **Step 1: Confirm the tree is dirty per nixfmt**

```bash
nix fmt -- --check . ; echo "exit=$?"
```
Expected: non-zero exit, and a list of files nixfmt would change.

- [ ] **Step 2: Confirm the working tree is clean before reformatting**

```bash
git status --porcelain
```
Expected: no output. If anything is listed, stop — the reformat commit must not pick up unrelated changes.

- [ ] **Step 3: Reformat**

```bash
nix fmt -- --verify .
```

`--verify` makes nixfmt sanity-check its own output after formatting. It is not the default and is worth the cost exactly once, on a bulk rewrite of 105 files.

- [ ] **Step 4: Verify nothing but `.nix` files changed**

```bash
git status --porcelain | grep -v '\.nix$' ; echo "non-nix files: $?"
```
Expected: no file paths listed (`grep` exits 1, printing `non-nix files: 1`). If any non-`.nix` path appears, `git checkout` it before committing.

- [ ] **Step 5: Verify the scale is what the spec predicted**

```bash
git diff --stat | tail -1
```
Expected: roughly 105 files changed, ~4000 lines touched. A wildly different number means something other than formatting happened — investigate before committing.

- [ ] **Step 6: Verify idempotence**

```bash
nix fmt && git diff --stat | tail -1
```
Expected: the stat line is unchanged from Step 5 — the second run produced no further diff. A formatter that is not idempotent would make every future `nix fmt` a new diff.

- [ ] **Step 7: Verify the reformat changed no behaviour**

```bash
nix flake check
```
Expected: succeeds. Formatting is whitespace-only, so both checks must still pass.

```bash
nix eval --raw --apply 'ls: (builtins.head (builtins.filter (l: l.name == "nix") ls)).formatter.command' \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.languages.language'
```
Expected: still prints `nixfmt`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "style: reformat with nixfmt

Mechanical nixfmt run over the whole tree. No logic changed.

Added to .git-blame-ignore-revs in the following commit."
```

- [ ] **Step 9: Record the SHA for Task 3**

```bash
git rev-parse HEAD
```
Write this SHA down — Task 3 needs it verbatim.

---

### Task 3: Teach git blame to skip the reformat

**Files:**
- Create: `.git-blame-ignore-revs`

**Interfaces:**
- Consumes: the 40-character commit SHA printed by Task 2 Step 9.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Confirm blame is currently polluted**

Pick a file the reformat touched and check who last touched a line:

```bash
git log -1 --format='%s' $(git blame -L 10,10 --porcelain modules/users/nixos.nix | head -1 | cut -d' ' -f1)
```
Expected: prints `style: reformat with nixfmt` — the reformat is masking the real author of that line. (If it prints something else, that particular line happened not to be reformatted; try another line number.)

- [ ] **Step 2: Create the file**

Create `.git-blame-ignore-revs` with the SHA from Task 2 Step 9 substituted in:

```
# Repo-wide reformat, nixpkgs-fmt -> nixfmt. No logic changed.
0000000000000000000000000000000000000000
```

Replace the zeros with the real 40-character SHA. A wrong or abbreviated SHA makes git error out on every blame, so copy it exactly.

- [ ] **Step 3: Enable it for this clone**

This is per-clone git config and cannot be committed. GitHub reads the file automatically; local git does not.

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

- [ ] **Step 4: Verify blame now skips the reformat**

Re-run the Step 1 command:

```bash
git log -1 --format='%s' $(git blame -L 10,10 --porcelain modules/users/nixos.nix | head -1 | cut -d' ' -f1)
```
Expected: prints the real commit subject that authored that line — anything other than `style: reformat with nixfmt`.

- [ ] **Step 5: Commit**

```bash
git add .git-blame-ignore-revs
git commit -m "chore: ignore the nixfmt reformat in git blame

GitHub honours this file automatically. Local clones need:

    git config blame.ignoreRevsFile .git-blame-ignore-revs"
```

---

### Task 4: Confirm no trace of the old tooling remains

**Files:** none modified — this task is verification only.

**Interfaces:**
- Consumes: the finished state of Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Verify the archived formatter is gone**

```bash
rg nixpkgs-fmt ; echo "exit=$?"
```
Expected: no matches (`exit=1`). Note `docs/superpowers/` will match, since the spec and this plan both discuss nixpkgs-fmt by name — matches confined to `docs/` are expected and fine. Any match under `flake.nix`, `modules/`, `hosts/`, `users/` or `tests/` is a failure.

- [ ] **Step 2: Verify the unused LSP is gone**

```bash
rg '\bnixd\b' ; echo "exit=$?"
```
Expected: matches only under `docs/`. Any match elsewhere is a failure.

- [ ] **Step 3: Verify the formatter is reachable the three ways it should be**

```bash
nix fmt -- --version
```
Expected: `1.4.0`.

```bash
nix develop --command nixfmt --version
```
Expected: `1.4.0` — confirms the devShell (and therefore direnv) provides it.

```bash
nix eval --raw --apply 'ls: (builtins.head (builtins.filter (l: l.name == "nix") ls)).formatter.command' \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.programs.helix.languages.language'
```
Expected: `nixfmt` — confirms helix will invoke it on save.

- [ ] **Step 4: Verify the tree is clean and formatted**

```bash
nix fmt -- --check . ; echo "exit=$?"
git status --porcelain
```
Expected: `exit=0` and no output from `git status`.

- [ ] **Step 5: Verify checks still pass**

```bash
nix flake check
```
Expected: succeeds.

No commit — this task changes nothing.
