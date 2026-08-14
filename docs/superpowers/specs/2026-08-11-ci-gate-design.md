# CI Gate: verify main before the hosts deploy it

## Problem

`modules/system/nixos.nix` points `system.autoUpgrade` at
`github:BJSummerfield/nixcfg` with `allowReboot = true`, and elitebook,
paynefield and vps enable it. Nothing verifies that ref. The repo has no
`.github/` directory and no workflows at all.

A push that breaks evaluation reaches three machines at 04:00.

Requiring pull requests would not fix it: only 6 of the last 30 commits on
`main` arrived through one. The rest were pushed directly, including the two
most recent. Any gate that depends on PR discipline would miss most of what
lands.

`nix flake check` is also nearly empty as a safety net — it evaluates
redtruck and the devbox tests. elitebook, t495, paynefield, vps and mac are
unchecked.

## Goal

The auto-upgrading hosts only ever move to a commit that has been evaluated
successfully, without changing how commits reach `main`.

## Decisions

- **Gate on a ref, not on branch protection.** CI fast-forwards a `verified`
  branch on success; hosts track that instead of `main`. The gate is the ref
  itself, so it holds regardless of whether a change arrived by PR or by
  direct push.
- **Evaluate, do not build.** Forcing each configuration's
  `toplevel.drvPath` catches option errors, missing attributes, type errors
  and failed assertions — the breakage this repo actually produces. Building
  would additionally catch package-level failures but needs a cache or a
  self-hosted runner, and a build failure already fails safe (autoUpgrade
  aborts and the host holds).
- **One Ubuntu runner covers everything.** All five NixOS hosts are
  `x86_64-linux`, and `darwinConfigurations.mac` evaluates on Linux
  (verified: it produces `darwin-system-26.11.15abb8c.drv`). No macOS job.
- **GitHub-hosted, not self-hosted.** The repo is public; a self-hosted
  runner would let fork PRs execute code on the host machine.
- **Failure signal is GitHub's default email.** No staleness job, no
  notification service.

## Scope

**In:**

- `flake.nix` — generalize `checks.x86_64-linux` over every configuration
- `.github/workflows/check.yml` — new
- `modules/system/nixos.nix` — repoint `autoUpgrade.flake`
- Creating the `verified` branch

**Out:** building hosts in CI, VM boot tests, branch protection, notification
services, and the unrelated findings (duplicated `mine.allowedUnfree`,
`rev = "main"` package pins, deadnix/statix cleanup, flake.nix boilerplate).

## Approach

### The flake change

Replace the hand-written `redtruck-eval` with a mapping over every
configuration, so a host added later is covered without anyone remembering
to add it:

```nix
checks.x86_64-linux =
  let
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
    # Forces a full evaluation without building anything.
    evalOnly = name: drv:
      builtins.seq drv (pkgs.runCommand "eval-${name}" { } "touch $out");
    evalAll = prefix: nixpkgs.lib.mapAttrs' (name: cfg:
      nixpkgs.lib.nameValuePair "${prefix}-${name}"
        (evalOnly name cfg.config.system.build.toplevel.drvPath));
  in
  evalAll "nixos" inputs.self.nixosConfigurations
  // evalAll "darwin" inputs.self.darwinConfigurations
  // {
    devboxes = import ./tests/devboxes.nix {
      inherit nixpkgs inputs;
      system = "x86_64-linux";
    };
  };
```

The verification lives here rather than in workflow YAML so that
`nix flake check` locally does exactly what CI does.

### The workflow

`.github/workflows/check.yml`:

```yaml
name: check
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: write          # needed only by the ref-advance step

concurrency:               # serialize, so two quick pushes cannot race the ref
  group: verified
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0     # a shallow clone cannot push: "shallow update not allowed"
      - uses: cachix/install-nix-action@v31
      - run: nix flake check --print-build-logs
      - name: Advance verified
        if: github.event_name == 'push'
        run: git push origin HEAD:verified
```

`fetch-depth: 0` is load-bearing, not incidental. `actions/checkout` defaults
to a shallow clone, and pushing from one is rejected outright.

The push is deliberately not forced: if `main` is ever force-pushed, the
advance fails as a non-fast-forward and CI goes red rather than moving the
hosts onto rewritten history. Pushes made with `GITHUB_TOKEN` do not trigger
workflows, and the branch filter excludes `verified` regardless, so there is
no recursion.

### The host change

```nix
flake = "github:BJSummerfield/nixcfg/verified";
```

**Ordering requirement:** `verified` must exist before that line reaches the
hosts, or all three auto-upgrades fail on an unresolvable flake ref. Create
the branch at current `main` first, then merge.

## Failure modes

| Situation | Result |
|---|---|
| CI fails on a push | `verified` holds; hosts keep the last good config and retry nightly. Intended. |
| `main` force-pushed | Ref advance rejected, CI red. Hosts hold. |
| Evaluates but fails to build on the host | autoUpgrade fails, host holds. Unchanged from today. |
| Builds, switches, then will not boot | **Not caught.** |

The last row is the limit of this design. Catching it needs a VM boot test,
which is deliberately out of scope. `allowReboot = true` keeps that residual
risk.

## Verification

- Break a host config locally; `nix flake check` fails naming that host.
  Restore it; the check passes.
- `nix flake check` reports a check per configuration — `nixos-elitebook`,
  `nixos-redtruck`, `nixos-t495`, `nixos-paynefield`, `nixos-vps`,
  `darwin-mac` — plus `devboxes`.
- On a real green push to `main`, `verified` moves to that commit.
- On a red push, `verified` does not move.
- `git log origin/verified -1` matches the newest green commit on `main`.

## Success Criteria

- Every configuration is evaluated by `nix flake check`, locally and in CI.
- `verified` advances only on green runs.
- The three auto-upgrading hosts track `verified`.
- A broken commit on `main` leaves the hosts on their previous generation.
