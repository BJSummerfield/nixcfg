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
- Files that agents read (`AGENTS.md`, `modules/devbox/ENVIRONMENT.md`,
  `modules/devbox/delegation.md`, `modules/devbox/writing.md`) carry no dates
  or provenance notes; git history has those.

## Light checks

- `nixfmt --check <file>`, `statix check <file>` and `deadnix --fail <file>`
  on each touched `.nix` file.
- `nix eval` of one attribute, for example
  `nix eval --raw '.#nixosConfigurations.redtruck.config.containers.devbox.config.home-manager.users.agent.home.file.".pi/agent/AGENTS.md".source'`,
  or `nix build --no-link --print-out-paths` of one such file attribute, one
  flake package, or one entry of `.#checks.x86_64-linux` other than the
  `nixos-*` ones. New files must be `git add`ed first; flake
  evaluation does not see untracked files.

## Heavy checks

These run one at a time, under
`flock -w 7200 /var/tmp/pi-plans/locks/heavy.lock <command>`.

- `nix flake check`: evaluates every host, runs the formatter, statix and
  deadnix gates and builds the flake packages. Several minutes and several
  GB of memory; two in parallel have taken the box down.
- Any host toplevel build
  (`nix build .#nixosConfigurations.<host>.config.system.build.toplevel`) and
  any home-manager activation package.

## Changes agents do not make

- Flake-input bumps or any edit to `flake.lock`: they force a rebuild of the
  LLM engine's CUDA packages and have livelocked the host.
- Host rebuilds or deploys. For a change that can only be verified after one,
  the final report to the user states the rebuild and the checks to run;
  the pull request body does not.
