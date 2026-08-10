# Paseo Desktop Module

## Problem

The Paseo desktop app is reachable only as a browser tab at
`devbox.mist-gamma.ts.net`. There is no declarative way to install it, and the
`paseo` flake input is currently consumed for the daemon alone.

## Goal

`modules/paseo-desktop/` installs the Paseo desktop app on t495, redtruck and
mac, configured as a **client of the devbox daemon** rather than a second
daemon of its own.

## Constraint: client, not server

The app spawns its own daemon by default. `desktop-settings.ts:49` defaults
`daemon.manageBuiltInDaemon` to `true`, and `daemon-manager.ts:393` calls
`spawnProcess` to launch it.

Left at the default on redtruck, a desktop launch by `waktu` would start a
second daemon in `~/.paseo`, outside the devbox container — no isolation, and
with `waktu`'s ssh/sops/signing keys in reach. The module's job is to make
"client" the default rather than a thing to remember.

The off switch is `daemon.manageBuiltInDaemon = false`, which
`daemon-manager.ts:305` honours by refusing to start the bundled daemon.

## Design

### Package source

Split by platform, mirroring `modules/firefox/darwin.nix`.

**Linux** — `modules/paseo-desktop/home.nix`, option
`mine.user.paseo-desktop.enable`:

```nix
home.packages = [ inputs.paseo.packages.${pkgs.stdenv.hostPlatform.system}.desktop ];
```

From the locked input, not `github:getpaseo/paseo`. The input sets
`nixpkgs.follows`, and `desktop-package.nix:61` does `inherit (paseo) npmDeps`
to share the daemon's npm-deps FOD; fetching the flake fresh would forfeit
both. `inputs` reaches home modules via `extraSpecialArgs`
(`modules/users/nixos.nix:107`, `modules/users/darwin.nix:20`). AGPL-3.0+, so
no `mine.allowedUnfree` entry.

**Darwin** — `modules/paseo-desktop/darwin.nix`, option
`mine.system.paseo-desktop.enable`:

```nix
homebrew.casks = [ "paseo" ];
```

The `paseo` cask is in `homebrew/cask` (0.3.1, `Paseo-0.3.1-arm64.dmg`,
`macos >= 12`). This avoids an Electron build and a full Expo export on
darwin. `mac-app-util` is not involved — the cask installs into
`/Applications` directly.

Registered in `modules/home.nix`, `modules/home-darwin.nix` (settings seeding
applies to the cask install too) and `modules/darwin.nix`.

The home module is imported on both platforms but installs a package only on
Linux — the `home.packages` line is guarded by
`pkgs.stdenv.hostPlatform.isLinux`. On darwin the home module contributes
settings seeding and nothing else; the cask is the only installer.

### Settings seeding

Electron resolves `userData` from the app name, which `main.ts:104` sets to
`"Paseo"`:

- Linux: `~/.config/Paseo/desktop-settings.json`
- Darwin: `~/Library/Application Support/Paseo/desktop-settings.json`

A `home.activation` entry after `writeBoundary` creates the parent directory if
needed and writes this file **only when it does not already exist**:

```json
{
  "version": 1,
  "settings": { "daemon": { "manageBuiltInDaemon": false } },
  "migrations": {
    "legacyRendererSettingsImported": true,
    "daemonStopOnQuitDefaultApplied": true
  }
}
```

Three decisions:

- **Seed-if-absent, not `home.file`.** The app owns this file and rewrites it
  with `writeFile` + `rename`. A store symlink would be replaced on the app's
  first write, then re-clobbered on the next activation, silently reverting
  in-app changes.
- **Partial document.** `coerceDocument` runs `coerceDesktopSettings` from
  `DEFAULT_DESKTOP_SETTINGS` and overrides only present keys, so omitted fields
  track upstream defaults instead of freezing today's values.
- **`legacyRendererSettingsImported: true`.** Left false,
  `pickDesktopSettingsFromLegacyRendererSettings` can emit a patch containing
  `daemon.manageBuiltInDaemon` and turn the built-in daemon back on.

On darwin, `modules/paseo-desktop/darwin.nix` sets
`home-manager.sharedModules = [{ mine.user.paseo-desktop.enable = true; }]` so
the cask flag implies the seeding, as `modules/niri/nixos.nix:24` already does.

### Host connection: out of scope, deliberately

The devbox connection is a one-time in-app step, not a module concern:

- `host-runtime.ts:1930` persists the registry with
  `storage.setItem(REGISTRY_STORAGE_KEY, ...)` — renderer storage inside the
  Electron profile, with no stable on-disk contract.
- `DirectTcpHostConnectionSchema` carries a `password` field. The devbox
  password is sops-managed specifically to stay out of the world-readable
  store.

In-app values: endpoint `devbox.mist-gamma.ts.net:443`, `useTls: true`,
password from `devbox-paseo-password`.

### Enablement

| Host | Flag |
|---|---|
| t495 | `mine.user.paseo-desktop.enable = true` (waktu) |
| redtruck | `mine.user.paseo-desktop.enable = true` (waktu) |
| mac | `mine.system.paseo-desktop.enable = true` |

## Non-goals

- Running agents locally on t495, redtruck or mac.
- Declaring the host registry or the daemon password in Nix.
- A `builtInDaemon.enable` option to opt back into local-daemon mode.

## Risks

**Version skew.** Homebrew tracks the latest cask while the Linux hosts and the
devbox daemon are pinned to flake rev `01a1d3b`. Both are 0.3.1 today. Bump the
flake input when the cask moves.

**Auto-updater.** `auto-updater.ts:103` sets `autoDownload = true` and there is
no "off" channel. On Linux the app launches `electron` directly, so
`app.isPackaged` is false and electron-updater skips unpacked apps — expected
to be inert, to be confirmed on first launch. On darwin the app self-updates
via Squirrel (`sh.paseo.desktop.ShipIt`, per the cask's uninstall stanza) and
brew also upgrades it, since the cask does not declare `auto_updates`. Normal
cask behaviour, not a Nix concern.

**Electron build cost on Linux.** The `paseo` flake declares no substituters,
so `packages.desktop` builds from source: `npm rebuild node-pty`,
`build:server`, an Expo web export and the Electron main build. Electron itself
substitutes from nixpkgs.

## Success Criteria

- `mine.user.paseo-desktop.enable` builds on t495 and redtruck and puts
  `paseo-desktop` on PATH with a working launcher entry under niri.
- `mine.system.paseo-desktop.enable` installs the cask on mac.
- On a machine with no prior Paseo profile, first launch starts **no** local
  daemon.
- An existing `desktop-settings.json` is never overwritten by activation.
- The devbox daemon is reachable from the app after adding the host once.
