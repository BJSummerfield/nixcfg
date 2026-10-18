# Working in this repository

nixcfg is one flake for every machine. Pull requests target `main` and are
squash-merged, so the PR title becomes the commit subject. Merging deploys
nothing by itself; each host picks the change up at its next upgrade.

## Conventions

- Comments in `.nix` files are reserved for manual, out-of-band setup steps,
  the commands a human still has to run by hand (`tailscale up`, `tailscale
  serve`, container first-run), and for lint directives. Everything else is
  said in code; numbers and reasons go in the commit body.
- `statix`'s `repeated_keys` lint is disabled repo-wide (`statix.toml`).
  `hosts/*/hardware-configuration.nix` is generated and excluded from deadnix.
- Files that agents read (`AGENTS.md`, `ENVIRONMENT.md`, prompt fragments
  under `modules/pi-coding-agent/agents/`) carry no dates or provenance
  notes; git history has those.

## Light checks (a helper may run these on its own)

- `nixfmt --check <file>`, `statix check <file>` and `deadnix --fail <file>`
  on each touched `.nix` file.
- `nix eval` of one attribute, for example
  `nix eval --raw '.#nixosConfigurations.redtruck.config.containers.devbox.config.home-manager.users.agent.home.file.".pi/agent/AGENTS.md".source'`,
  or `nix build --no-link --print-out-paths` of one such file attribute, one
  flake package, or one entry of `.#checks.x86_64-linux` other than the
  `nixos-*` and `darwin-*` ones. New files must be `git add`ed first; flake
  evaluation does not see untracked files.

## Heavy checks (once per round, under the box-wide lock)

- `nix flake check`: evaluates every host, runs the formatter, statix and
  deadnix gates, builds the flake packages and the extension tests. Several
  minutes and several GB of memory; two in parallel have taken the box down.
- Any host toplevel build
  (`nix build .#nixosConfigurations.<host>.config.system.build.toplevel`) and
  any home-manager activation package.

## Changes agents do not make

- Flake-input bumps or any edit to `flake.lock`: they force a rebuild of the
  LLM engine's CUDA packages and have livelocked the host.
- Anything whose verification needs a host rebuild or a deploy. Such a change
  is described in the PR body as a step for the user to run.
