# nixcfg

A NixOS / nix-darwin flake that configures a small fleet of home machines — laptops, a VPS, a Mac — from shared, purpose-scoped modules, with sops-encrypted secrets.

## Language

**Host**:
A machine declared in `flake.nix` (`nixosConfigurations` or `darwinConfigurations`), with its configuration under `hosts/<name>/`.
_Avoid_: machine, target, node

**Module**:
A directory under `modules/` that a host imports — directly or through the shared import lists `modules/nixos.nix` and `modules/home.nix` — and that exposes a `mine.*` option subtree. The file names inside name the target: `nixos.nix` (NixOS system), `home.nix` (home-manager), `darwin.nix` / `home-darwin.nix` (macOS), `package.nix` (builds a package).
_Avoid_: config, setting, component

**User**:
A person or dedicated account, defined once in `users/<name>.nix` and present only on the hosts that import it.
_Avoid_: account, profile

**mine**:
The option namespace this repo owns: `mine.system.*` for NixOS system options, `mine.user.*` for per-user (home-manager) options. Every module's options live under it.
_Avoid_: config, options

### Kiosk

**Kiosk**:
A single-app session mode for a person: one app wrapped in gamescope and auto-started — either machine-level (greetd auto-logs in a dedicated user, e.g. the Jellyfin TV kiosk) or per-user on a shared host (e.g. the children's Steam). Replaces the old `jellybox`/`steambox` modules.
_Avoid_: box, appliance, service

### Containers

**Microserver**:
One or more services running inside a NixOS container (nspawn), reached from anywhere on the tailnet via the container's own tailnet node. Multiple microservers can run on one host; the point is per-app isolation and multiple nodes per machine.
_Avoid_: container (alone), VM, microservice (the cloud meaning)

**Devbox**:
A microserver instance running the coding-agent stack (pi and Claude with Superpowers skills and subagent fan-out tiers, declared as versionless membership in nix). The instance names `devbox` and `workbox` are deliberate and stable — they are the container names and tailnet hostnames typed daily.
_Avoid_: dev shell, workspace, kiosk, the module's old name (it is an instance, not the machinery)
