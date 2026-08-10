# Paseo Desktop Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the Paseo desktop app declaratively on t495, redtruck and mac, configured as a client of the devbox daemon rather than one that spawns its own.

**Architecture:** A cross-platform home-manager module seeds `desktop-settings.json` with `manageBuiltInDaemon = false` and, on Linux only, installs `inputs.paseo.packages.<system>.desktop`. A separate darwin module installs the `paseo` homebrew cask and turns the home module on via `home-manager.sharedModules`.

**Tech Stack:** Nix flakes, home-manager, nix-darwin, nix-homebrew.

**Spec:** `docs/superpowers/specs/2026-08-10-paseo-desktop-module-design.md`

## Global Constraints

- Comments follow `docs/superpowers/specs/2026-08-09-comment-style-design.md`: one blunt sentence stating the reason, no history, no cross-references, no explaining Nix.
- Import lists and `enable` blocks stay alphabetically sorted.
- The desktop package comes from `inputs.paseo`, never `github:getpaseo/paseo` — the input sets `nixpkgs.follows` and shares the daemon's npm-deps FOD.
- No `mine.allowedUnfree` entry: the package is AGPL-3.0+.
- Run every `nix` command from the repo root with `--no-write-lock-file`.
- The seeded settings document is partial on purpose. Do not write a full settings object.

---

### Task 1: Cross-platform home module

**Files:**
- Create: `modules/paseo-desktop/home.nix`
- Modify: `modules/home.nix:25` (insert after `./opencode/home.nix`)
- Modify: `modules/home-darwin.nix:14` (insert after `./opencode/home.nix`)
- Modify: `hosts/t495/default.nix:86` (insert after `mako.enable = true;`)
- Modify: `hosts/redtruck/default.nix:132` (insert after `obs-studio.enable = true;`)

**Interfaces:**
- Consumes: `inputs.paseo.packages.<system>.desktop` from the flake input locked at rev `01a1d3b`.
- Produces: option `mine.user.paseo-desktop.enable` (bool, default false) and activation entry `home.activation.paseoDesktopSettings`. Task 2 sets the option to `true` through `home-manager.sharedModules`.

- [ ] **Step 1: Verify the option does not exist yet**

```bash
nix eval --no-write-lock-file \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.mine.user.paseo-desktop.enable'
```

Expected: FAIL with `error: flake '...' does not provide attribute '...mine.user.paseo-desktop.enable'`

- [ ] **Step 2: Create the module**

Create `modules/paseo-desktop/home.nix`:

```nix
{ pkgs, lib, config, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;
  cfg = config.mine.user.paseo-desktop;

  # Electron derives userData from the app name, which main.ts pins to "Paseo".
  settingsDir =
    if isDarwin
    then "${config.home.homeDirectory}/Library/Application Support/Paseo"
    else "${config.xdg.configHome}/Paseo";

  # Partial document: coerceDocument fills omitted keys from upstream defaults.
  # legacyRendererSettingsImported stops a legacy import re-enabling the daemon.
  settingsSeed = pkgs.writeText "paseo-desktop-settings.json" (builtins.toJSON {
    version = 1;
    settings.daemon.manageBuiltInDaemon = false;
    migrations = {
      legacyRendererSettingsImported = true;
      daemonStopOnQuitDefaultApplied = true;
    };
  });
in
{
  options.mine.user.paseo-desktop.enable =
    mkEnableOption "Paseo desktop app as a client for a remote daemon";

  config = mkIf cfg.enable {
    # Darwin installs the app from a homebrew cask instead - see darwin.nix.
    home.packages =
      lib.optional isLinux inputs.paseo.packages.${pkgs.stdenv.hostPlatform.system}.desktop;

    # Seeded only when absent: the app rewrites this file itself, so a home.file
    # symlink would be replaced on its first write and re-clobbered every
    # activation.
    home.activation.paseoDesktopSettings =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        settings_dir="${settingsDir}"
        if [ ! -e "$settings_dir/desktop-settings.json" ]; then
          run mkdir -p $VERBOSE_ARG "$settings_dir"
          run install $VERBOSE_ARG -m 0644 ${settingsSeed} \
            "$settings_dir/desktop-settings.json"
        fi
      '';
  };
}
```

- [ ] **Step 3: Register in both home aggregators**

In `modules/home.nix`, add between `./opencode/home.nix` and `./pi-coding-agent/home.nix`:

```nix
    ./paseo-desktop/home.nix
```

In `modules/home-darwin.nix`, add immediately after `./opencode/home.nix`:

```nix
    ./paseo-desktop/home.nix
```

- [ ] **Step 4: Enable on t495 and redtruck**

In `hosts/t495/default.nix`, add after `mako.enable = true;`:

```nix
        paseo-desktop.enable = true;
```

In `hosts/redtruck/default.nix`, add after `obs-studio.enable = true;`:

```nix
        paseo-desktop.enable = true;
```

- [ ] **Step 5: Verify the option now evaluates true on both hosts**

```bash
nix eval --no-write-lock-file \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.mine.user.paseo-desktop.enable'
nix eval --no-write-lock-file \
  '.#nixosConfigurations.redtruck.config.home-manager.users.waktu.mine.user.paseo-desktop.enable'
```

Expected: `true` from each.

- [ ] **Step 6: Verify the desktop package lands in the profile**

```bash
nix eval --no-write-lock-file --raw \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.home.packages' \
  --apply 'ps: builtins.concatStringsSep "\n" (map (p: p.name) ps)' | grep paseo-desktop
```

Expected: prints `paseo-desktop-0.3.0`. This forces evaluation of the package attribute without building it. The version tracks the pinned input rev `01a1d3b`, not upstream HEAD — do not expect it to match the homebrew cask.

- [ ] **Step 7: Verify the seeded JSON is what the spec requires**

```bash
nix eval --no-write-lock-file --raw \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.home.activation.paseoDesktopSettings.data'
```

Expected: the activation script text, containing a `/nix/store/...-paseo-desktop-settings.json` path and an `if [ ! -e ` guard. Then confirm the seed contents:

```bash
cat "$(nix eval --no-write-lock-file --raw \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.home.activation.paseoDesktopSettings.data' \
  | grep -o '/nix/store/[a-z0-9]*-paseo-desktop-settings.json' | head -1)"
```

Expected exactly:

```json
{"migrations":{"daemonStopOnQuitDefaultApplied":true,"legacyRendererSettingsImported":true},"settings":{"daemon":{"manageBuiltInDaemon":false}},"version":1}
```

- [ ] **Step 8: Verify the darwin config still evaluates**

The module is now imported by `modules/home-darwin.nix`, so a Linux-only expression in it would break the mac host even while disabled.

```bash
nix eval --no-write-lock-file \
  '.#darwinConfigurations.mac.config.home-manager.users.brian.mine.user.paseo-desktop.enable'
```

Expected: `false`.

- [ ] **Step 9: Build the t495 home profile**

This is the real gate for the Linux side and it builds the Electron app from source — no substituter is configured for the paseo flake, so budget significant time. Run it in the background and check back.

```bash
nix build --no-write-lock-file --out-link /tmp/paseo-t495-result --print-out-paths -L \
  '.#nixosConfigurations.t495.config.home-manager.users.waktu.home.activationPackage' \
  > /tmp/task1-build.log 2>&1
```

Expected: prints a store path, exit 0.

Use `--out-link`, not `--no-link`: this build takes hours and without a GC root the result is collected within hours, so a later re-check finds the path gone and looks like a failure that never happened.

- [ ] **Step 10: Commit**

```bash
git add modules/paseo-desktop/home.nix modules/home.nix modules/home-darwin.nix \
  hosts/t495/default.nix hosts/redtruck/default.nix
git commit -m "feat(paseo-desktop): home module, enabled on t495 and redtruck"
```

---

### Task 2: Darwin homebrew cask module

**Files:**
- Create: `modules/paseo-desktop/darwin.nix`
- Modify: `modules/darwin.nix:7` (insert after `./keybase/darwin.nix`)
- Modify: `hosts/mac/default.nix:29` (insert after `keybase.enable = true;`)

**Interfaces:**
- Consumes: `mine.user.paseo-desktop.enable` from Task 1.
- Produces: option `mine.system.paseo-desktop.enable` (bool, default false).

- [ ] **Step 1: Verify the option does not exist yet**

```bash
nix eval --no-write-lock-file '.#darwinConfigurations.mac.config.mine.system.paseo-desktop.enable'
```

Expected: FAIL with `does not provide attribute`.

- [ ] **Step 2: Create the darwin module**

Create `modules/paseo-desktop/darwin.nix`:

```nix
# Homebrew cask rather than the nix package: the darwin build runs electron-builder
# and a full Expo web export.
{ lib, config, ... }:
{
  options.mine.system.paseo-desktop.enable =
    lib.mkEnableOption "Paseo desktop app from homebrew";

  config = lib.mkIf config.mine.system.paseo-desktop.enable {
    homebrew.casks = [ "paseo" ];

    # The cask flag implies the client-mode settings seed.
    home-manager.sharedModules = [{ mine.user.paseo-desktop.enable = true; }];
  };
}
```

- [ ] **Step 3: Register in the darwin aggregator**

In `modules/darwin.nix`, add between `./keybase/darwin.nix` and `./system/darwin.nix`:

```nix
    ./paseo-desktop/darwin.nix
```

- [ ] **Step 4: Enable on mac**

In `hosts/mac/default.nix`, add after `keybase.enable = true;`:

```nix
    paseo-desktop.enable = true;
```

- [ ] **Step 5: Verify the cask is declared**

```bash
nix eval --no-write-lock-file --json '.#darwinConfigurations.mac.config.homebrew.casks' \
  --apply 'cs: map (c: c.name) cs'
```

Expected: a JSON list containing `"paseo"`.

Map over `.name`; do not use `builtins.elem "paseo" cs`. nix-darwin coerces each cask string into a submodule, so an `elem` test against a string returns `false` for every cask — including ones that have worked for years.

- [ ] **Step 6: Verify the system flag implied the user flag**

```bash
nix eval --no-write-lock-file \
  '.#darwinConfigurations.mac.config.home-manager.users.brian.mine.user.paseo-desktop.enable'
```

Expected: `true`. This is what turns on settings seeding for `brian`.

- [ ] **Step 7: Verify no nix package is installed on darwin**

```bash
nix eval --no-write-lock-file --raw \
  '.#darwinConfigurations.mac.config.home-manager.users.brian.home.packages' \
  --apply 'ps: builtins.concatStringsSep "\n" (map (p: p.name) ps)' | grep -c paseo-desktop
```

Expected: `0`. The cask is the only installer on darwin; a non-zero count means the `isLinux` guard in Task 1 is wrong and a darwin Electron build would be triggered.

- [ ] **Step 8: Verify the darwin settings path is the macOS one**

```bash
nix eval --no-write-lock-file --raw \
  '.#darwinConfigurations.mac.config.home-manager.users.brian.home.activation.paseoDesktopSettings.data' \
  | grep "Library/Application Support/Paseo"
```

Expected: a match. An `~/.config/Paseo` path here means the platform branch is inverted and the seed would land where Electron never looks.

- [ ] **Step 9: Verify the mac system config still evaluates**

```bash
nix eval --no-write-lock-file --raw '.#darwinConfigurations.mac.system.drvPath'
```

Expected: a `/nix/store/...-darwin-system-....drv` path. Full evaluation of the darwin host; it cannot be built from a Linux machine.

- [ ] **Step 10: Commit**

```bash
git add modules/paseo-desktop/darwin.nix modules/darwin.nix hosts/mac/default.nix
git commit -m "feat(paseo-desktop): homebrew cask on darwin"
```

---

### Task 3: Runtime verification

Manual, and it needs a GUI session on each of t495, redtruck and mac. Nothing here can be checked from a build machine. Do not mark Tasks 1 and 2 as verified on the strength of evaluation alone — the spec's load-bearing success criteria are behavioural.

**Files:** none.

**Interfaces:**
- Consumes: a switched configuration from Tasks 1 and 2.

- [ ] **Step 1: Switch the host**

```bash
sudo nixos-rebuild switch --flake .#t495
```

- [ ] **Step 2: Confirm the seed landed**

```bash
cat ~/.config/Paseo/desktop-settings.json
```

Expected: the partial document with `"manageBuiltInDaemon":false`.

- [ ] **Step 3: Confirm the seed is not a store symlink**

```bash
test -L ~/.config/Paseo/desktop-settings.json && echo "SYMLINK - WRONG" || echo "regular file - correct"
```

Expected: `regular file - correct`. A symlink means `home.file` was used instead of the activation entry and the app's first write will fail or be reverted.

- [ ] **Step 4: Confirm the launcher entry and icon are installed**

`home-manager.useUserPackages = true` (`modules/users/nixos.nix:106`) routes `home.packages` into `users.users.waktu.packages`, which lands under `/etc/profiles/per-user/waktu`, not `~/.nix-profile`.

```bash
ls /etc/profiles/per-user/waktu/share/applications/paseo-desktop.desktop \
   /etc/profiles/per-user/waktu/share/icons/hicolor/512x512/apps/paseo-desktop.png
command -v paseo-desktop
```

Expected: both files listed and a `paseo-desktop` path printed. The package ships a second `NoDisplay` entry named `Paseo.desktop` so the icon resolves whichever app_id Electron publishes; only `paseo-desktop.desktop` should appear in the launcher.

- [ ] **Step 5: Launch and confirm no local daemon starts**

Launch Paseo from the niri launcher, then:

```bash
pgrep -af "paseo.*daemon" || echo "no local daemon - correct"
```

Expected: `no local daemon - correct`. A match means the seed did not take effect and the app is running its own daemon.

Also launch from a terminal whose cwd is inside a linked git worktree, which is the case the `PASEO_ELECTRON_USER_DATA_DIR` wrapper env var guards against:

```bash
cd "$(ls -d /var/lib/paseo/worktrees/*/* | head -1)" && paseo-desktop &
```

Quote a single `ls -d ... | head -1` result rather than globbing directly: `cd /path/*/*` gets every match as separate arguments and bash exits 2 with "too many arguments" as soon as more than one worktree exists, which is the normal case.

Then confirm the wrapper actually pinned the directory:

```bash
ls -d ~/.config/Paseo-* 2>/dev/null && echo "WRONG - userData was redirected" \
  || echo "userData pinned to ~/.config/Paseo - correct"
pgrep -af "paseo.*daemon" || echo "no local daemon - correct"
```

Expected: `userData pinned to ~/.config/Paseo - correct` and `no local daemon - correct`. A `~/.config/Paseo-<worktree>` directory means the wrapper's env var did not reach the app and the seed was bypassed.

- [ ] **Step 6: Confirm activation never overwrites an existing file**

```bash
printf '{"version":1,"settings":{"notifications":{"playSound":false}}}' \
  > ~/.config/Paseo/desktop-settings.json
sudo nixos-rebuild switch --flake .#t495
cat ~/.config/Paseo/desktop-settings.json
```

Expected: the `playSound` document, unchanged. If activation replaced it, the `-e` guard is wrong and in-app settings changes will be lost on every rebuild.

- [ ] **Step 7: Restore the seeded settings**

```bash
rm ~/.config/Paseo/desktop-settings.json
sudo nixos-rebuild switch --flake .#t495
```

- [ ] **Step 8: Add the devbox host in-app**

In the app's host chooser, add a direct TCP connection:

- endpoint: `devbox.mist-gamma.ts.net:443`
- TLS: on
- password: the value of `PASEO_PASSWORD` in the `devbox-paseo-password` sops secret

Expected: the devbox host connects and its workspaces are listed. This is deliberately not declarative — the registry lives in renderer storage and the record holds the daemon password.

- [ ] **Step 9: Repeat on redtruck**

```bash
sudo nixos-rebuild switch --flake .#redtruck
```

Then re-run steps 2, 3, 4 and 5 on that host. This is the host where a stray local daemon would sit alongside the devbox container, so confirm step 5 explicitly rather than assuming it carries over from t495.

- [ ] **Step 10: Verify on mac**

Needs the mac itself; the cask cannot be installed from a Linux machine.

```bash
darwin-rebuild switch --flake .#mac
ls -d /Applications/Paseo.app
cat ~/Library/Application\ Support/Paseo/desktop-settings.json
test -L ~/Library/Application\ Support/Paseo/desktop-settings.json \
  && echo "SYMLINK - WRONG" || echo "regular file - correct"
```

Expected: `/Applications/Paseo.app` exists, the settings file holds `"manageBuiltInDaemon":false`, and it is a regular file. Then launch Paseo and confirm no local daemon:

```bash
pgrep -af "paseo.*daemon" || echo "no local daemon - correct"
```

Expected: `no local daemon - correct`. Finally add the devbox host as in step 8.
