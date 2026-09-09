# nixcfg

One flake for every machine I run: five NixOS hosts, one nix-darwin Mac, and the
home-manager configuration for their users. Secrets are sops-encrypted in-tree,
disks are declared with disko, and every host is on the same tailnet.

## Hosts

| Host | Platform | Role |
| --- | --- | --- |
| `redtruck` | NixOS | Desktop workstation (NVIDIA/CUDA). Runs the `local-llm` container and the `devbox` agent sandbox, plus printing and the media encode queue. |
| `t495` | NixOS | Laptop, niri desktop. |
| `elitebook` | NixOS | Couch machine — `jellybox` and `steambox`. |
| `paynefield` | NixOS | Home server — DNS, Jellyfin, Immich, Vikunja, Valheim, backups. |
| `vps` | NixOS | Public edge — Caddy (with the layer4 app), Stalwart mail, photoform, backups. |
| `mac` | nix-darwin | macOS workstation. |

## Layout

- `flake.nix` — inputs and the `nixosConfigurations` / `darwinConfigurations` outputs.
- `hosts/<name>/` — per-host config, `hardware-configuration.nix`, and `disko.nix`.
- `modules/` — the `mine.*` option modules, split into `nixos.nix` / `home.nix` / `darwin.nix` per feature.
- `users/` — per-user definitions.
- `packages/` — flake packages.
- `checks/` — the flake checks (see below).
- `secrets/` — sops-encrypted secrets, keyed to host SSH keys.
- `ci/`, `.github/workflows/check.yml` — CI, including the binary cache plumbing.
- `New_Host.md` — provisioning a brand new machine with `nixos-anywhere`.

## Working on it

```sh
nix develop                                   # nixfmt, sops, statix, deadnix
sudo nixos-rebuild switch --flake .#<host>    # NixOS
darwin-rebuild switch --flake .#mac           # macOS
nix fmt                                       # nixfmt via treefmt
nix flake check                               # everything below
```

`nix flake check` evaluates every host, runs the formatter/statix/deadnix gates,
builds the flake packages, and adapts each Caddy host's real Caddyfile.

## Conventions

- Comments in `.nix` files are reserved for manual, out-of-band setup steps — the
  commands a human still has to run by hand (`tailscale up`, `tailscale serve`,
  container first-run). Everything else is said in code.
- `statix`'s `repeated_keys` lint is disabled repo-wide; see `statix.toml`.
- Generated `hosts/*/hardware-configuration.nix` files are excluded from deadnix.
