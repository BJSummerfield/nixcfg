# nixcfg

A NixOS/nix-darwin flake configuring five Linux hosts and one Mac: laptops,
a GPU desktop that also hosts coding-agent containers, a home server, a VPS,
and a Mac.

## Hosts

| Host | Platform | Role |
| --- | --- | --- |
| `elitebook` | NixOS | Gamescope kiosk appliance — Steam Big Picture and a Jellyfin TV session, autologin via greetd. Not headless: `mine.system.steambox`/`jellybox` both drive a gamescope session. |
| `redtruck` | NixOS | GPU desktop (niri) that also hosts two coding-agent containers (`devbox`, `workbox`) and the local LLM stack. |
| `t495` | NixOS | Laptop, niri desktop, `_1password`, printing, Steam. |
| `paynefield` | NixOS | Home server: DNS, Jellyfin, Immich, a Terraria server, Vikunja, and backups. |
| `vps` | NixOS | Internet-facing: Stalwart mail, a Caddy SNI edge (photoform booking site), Teamspeak, backups. |
| `mac` | nix-darwin | Personal Mac, Homebrew casks for anything not nix-packaged. |

Source of truth: `flake.nix`'s `nixosConfigurations`/`darwinConfigurations` for
the host list, `hosts/<host>/default.nix` for what each one enables.

## Build

```
nix flake check
```

Evaluates every host's `system.build.toplevel`, builds every flake package,
and runs the lints below. This is also what CI runs on every PR
(`.github/workflows/check.yml`).

## Deploy

`elitebook`, `paynefield`, and `vps` have `mine.system.autoUpgrade.enable =
true` (see each host's `default.nix`): `modules/system/nixos.nix` points
`system.autoUpgrade.flake` at `github:BJSummerfield/nixcfg/verified`, and CI
advances the `verified` ref itself once `nix flake check` passes on a push to
`main` (`.github/workflows/check.yml`, the "Advance verified" step). Those
hosts pick up a change on their own schedule after it lands on `main`.

Hosts without `autoUpgrade` (`redtruck`, `t495`) are deployed by hand:

```
sudo nixos-rebuild switch --flake .#<host>
```

There is no in-repo wrapper for `mac`; nix-darwin's own switch command
applies there.

## The option namespace

Three tiers, and a knob's tier is not guessable from its name alone:

- **`mine.system.*`** — per-machine system policy. Set in
  `hosts/<host>/default.nix`. Defined across `modules/*/nixos.nix` and
  `modules/*/darwin.nix`.
- **`mine.accounts.*`** — the account registry: uid, password hash, SSH keys,
  NAS access. Declared in `modules/users/nixos.nix`, populated per-user by
  `users/*.nix`, and opted into by any host that imports one of those files.
  (In the code today this is still `mine.users.*`; a pending rename lands the
  `mine.accounts.*` spelling used here.)
- **`mine.user.*`** — per-user home-manager config, set inside
  `home-manager.users.<name>` in a host file.

## Secrets

Secrets are encrypted with [sops-nix](https://github.com/Mic92/sops-nix).
Recipients (which age keys can decrypt which files) are declared in
`.sops.yaml`; each host has its own age identity derived from its SSH host
key, and each dev machine additionally holds a user age key at
`~/.config/sops/age/keys.txt`. Hosts that need machine-scoped secrets keep
them one file per host at `secrets/hosts/<host>.yaml` (not every host has
one), plus shared files under `secrets/services/` and `secrets/users/` for
anything not scoped to a single machine. A host's `default.nix` wires each
secret in with `sops.secrets.<name>.sopsFile = ...`.

To rotate a key or re-encrypt after adding a recipient, you must already
hold one of the user keys currently on each file (your
`~/.config/sops/age/keys.txt`) — sops needs to decrypt with an existing
recipient's key before it can re-encrypt for the new list:

```fish
sops updatekeys ./secrets/**.yaml
```

`docs/new-host.md` walks the full procedure (new host key, new user key,
`.sops.yaml` edits, re-encrypting, committing before install) for the case
where the key is missing entirely rather than just rotating.

## Adding a host

Add a host module under `hosts/<name>/` (including a working `disko.nix`),
list it in `flake.nix`'s `nixosConfigurations`, and provision it with
`nixos-anywhere`. The full walkthrough — generating the host SSH key,
registering it in `.sops.yaml`, re-encrypting secrets, and rotating the
user's key afterward — is in [`docs/new-host.md`](docs/new-host.md).

## Checks

`nix flake check` runs a host/package eval for every `nixosConfigurations`
and `darwinConfigurations` entry and every flake package, plus `statix`,
`deadnix`, a formatting check, and the heavier `tests/devboxes.nix` and
`tests/photoform.nix` checks (`checks/default.nix`). Format the tree with:

```
nix fmt
```
