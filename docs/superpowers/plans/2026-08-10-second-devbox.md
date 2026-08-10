# Second Devbox Container (`workbox`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the singleton `mine.system.devbox` option into a multi-instance `mine.system.devboxes` attrset and add a second container, `workbox`, on `redtruck`.

**Architecture:** `modules/devbox/nixos.nix` becomes an `attrsOf (types.submodule ...)` keyed by container name, deriving `containers.<name>`, `ve-<name>`, and `/var/lib/tailscale-<name>` from the key. `modules/devbox/container.nix` becomes fully instance-agnostic: its in-container secret paths shorten to `/run/secrets/github-token` and `/run/secrets/paseo-password` (bind-mount destinations live in each container's private mount namespace, so both instances can share the names), and it gains a `gitIdentity` parameter. Verification is pure Nix evaluation exposed as flake `checks`.

**Tech Stack:** NixOS modules, `nixos-container` (systemd-nspawn), sops-nix, Nix flakes.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-second-devbox-design.md`.
- The first instance MUST stay keyed exactly `devbox` — `/var/lib/tailscale-devbox` holds its tailnet identity, and a rename forces a re-auth.
- `devbox` MUST keep `hostAddress = "192.168.100.26"` and `localAddress = "192.168.100.27"`.
- Instance names are limited to 12 characters (`ve-` + name must fit Linux's 15-char interface name limit).
- `container.nix` must contain no instance identity: no name, no per-instance path.
- Comment style follows `docs/superpowers/specs/2026-08-09-comment-style-design.md` — explain why, not what.
- Every existing option description in `modules/devbox/nixos.nix` is retained; only example paths change.
- Tests are evaluation-only. No `nixosTest` / VM. Negative assertion cases are deliberately untested.

---

### Task 1: Evaluation test harness

**Files:**
- Create: `tests/devboxes.nix`
- Modify: `flake.nix` (add `checks` output)

**Interfaces:**
- Produces: `tests/devboxes.nix` is a function `{ nixpkgs, inputs, system }: derivation`. The derivation succeeds (touches `$out`) when every check passes and fails printing `FAIL: <name>` lines otherwise.
- Consumes: nothing. This task is written against the *new* API (`mine.system.devboxes`), which does not exist yet — that is the point; it must fail.

- [ ] **Step 1: Write the failing test**

Create `tests/devboxes.nix`:

```nix
# Pure-evaluation checks for the multi-instance devbox module. No VM here on
# purpose: everything this refactor can break is a value derived from an
# instance's attribute name, and all of those are visible at eval time. The
# parts a VM could uniquely prove — that the tailnet join works, that
# `tailscale serve` publishes — are the manual steps the module deliberately
# keeps out of Nix.
{ nixpkgs, inputs, system }:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  # Only the two modules under test, plus the minimum NixOS needs to evaluate.
  # Deliberately not modules/nixos.nix: importing the whole module set would
  # make this check slow and couple it to modules it is not testing.
  host = (lib.nixosSystem {
    specialArgs = { inherit inputs; };
    modules = [
      ../modules/system/nixos.nix
      ../modules/devbox/nixos.nix
      {
        nixpkgs.hostPlatform = system;
        fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; };

        mine.system = {
          hostName = "devbox-test";
          externalInterface = "eth0";

          devboxes = {
            # Left at the default gitIdentity, to prove the default reaches
            # the container.
            devbox = {
              githubTokenFile = "/run/secrets/devbox-github-token";
              paseoPasswordFile = "/run/secrets/devbox-paseo-password";
              tailnetHostname = "devbox.example.ts.net";
              hostAddress = "192.168.100.26";
              localAddress = "192.168.100.27";
            };
            # Overrides gitIdentity, to prove the override reaches the
            # container and does not leak into the other instance.
            workbox = {
              githubTokenFile = "/run/secrets/workbox-github-token";
              paseoPasswordFile = "/run/secrets/workbox-paseo-password";
              tailnetHostname = "workbox.example.ts.net";
              hostAddress = "192.168.100.28";
              localAddress = "192.168.100.29";
              gitIdentity = {
                name = "Other Person";
                email = "other@example.com";
              };
            };
          };
        };
      }
    ];
  }).config;

  container = name: host.containers.${name};
  gitUser = name: (container name).config.home-manager.users.agent.programs.git.settings.user;

  checks = [
    {
      name = "both containers are defined";
      ok = lib.attrNames host.containers == [ "devbox" "workbox" ];
    }
    {
      name = "each container keeps its own veth addresses";
      ok = (container "devbox").hostAddress == "192.168.100.26"
        && (container "devbox").localAddress == "192.168.100.27"
        && (container "workbox").hostAddress == "192.168.100.28"
        && (container "workbox").localAddress == "192.168.100.29";
    }
    {
      name = "NAT lists every instance's veth";
      ok = lib.sort lib.lessThan host.networking.nat.internalInterfaces
        == [ "ve-devbox" "ve-workbox" ];
    }
    {
      name = "each instance gets its own tailscale state directory";
      ok = lib.elem "d /var/lib/tailscale-devbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-workbox 0700 root root -" host.systemd.tmpfiles.rules;
    }
    {
      name = "secrets bind-mount per-instance host paths onto shared container paths";
      ok = (container "devbox").bindMounts."/run/secrets/github-token".hostPath
          == "/run/secrets/devbox-github-token"
        && (container "devbox").bindMounts."/run/secrets/paseo-password".hostPath
          == "/run/secrets/devbox-paseo-password"
        && (container "workbox").bindMounts."/run/secrets/github-token".hostPath
          == "/run/secrets/workbox-github-token"
        && (container "workbox").bindMounts."/run/secrets/paseo-password".hostPath
          == "/run/secrets/workbox-paseo-password";
    }
    {
      name = "gitIdentity defaults, and an override applies to one instance only";
      ok = gitUser "devbox" == {
          name = "BJSummerfield";
          email = "brianjsummerfield@gmail.com";
        }
        && gitUser "workbox" == {
          name = "Other Person";
          email = "other@example.com";
        };
    }
    {
      name = "each container is served on its own tailnet hostname";
      ok = (container "devbox").config.services.paseo.hostnames == [ "devbox.example.ts.net" ]
        && (container "workbox").config.services.paseo.hostnames == [ "workbox.example.ts.net" ];
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "devboxes-eval-tests" { } (
  if failures == [ ]
  then "touch $out"
  else ''
    ${lib.concatMapStringsSep "\n"
      (f: "echo 'FAIL: ${f.name}' >&2") failures}
    exit 1
  ''
)
```

- [ ] **Step 2: Add the `checks` output**

In `flake.nix`, add a `checks` attribute alongside `devShells`. Scoped to
`x86_64-linux` rather than `forAllSystems`: both the test host and `redtruck`
are `x86_64-linux`, and evaluating a NixOS host under a darwin
`hostPlatform` would fail for reasons unrelated to what is being tested.

```nix
      # Evaluation-only. `nix flake check` builds nothing here beyond two
      # empty marker derivations; the work is in forcing the eval.
      checks.x86_64-linux = {
        devboxes = import ./tests/devboxes.nix {
          inherit nixpkgs inputs;
          system = "x86_64-linux";
        };

        # Guards the real host against a refactor that only breaks in
        # combination with the rest of its module set. drvPath forces a full
        # evaluation without building anything.
        redtruck-eval = builtins.seq
          inputs.self.nixosConfigurations.redtruck.config.system.build.toplevel.drvPath
          (nixpkgs.legacyPackages.x86_64-linux.runCommand "redtruck-eval" { } "touch $out");
      };
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nix flake check 2>&1 | tail -20`
Expected: FAIL. `mine.system.devboxes` does not exist yet, so the error is
`The option 'mine.system.devboxes' does not exist`. (`redtruck-eval` should
still pass at this point — nothing has changed on the host yet.)

If instead the error is about a missing option that `modules/system/nixos.nix`
needs (e.g. a bootloader or `mine.users` reference), add the minimum stub for
it to the test host's inline module and re-run. Do not switch to importing
`modules/nixos.nix`.

- [ ] **Step 4: Commit**

```bash
git add tests/devboxes.nix flake.nix
git commit -m "test(devbox): eval checks for multi-instance devboxes"
```

---

### Task 2: Multi-instance module

**Files:**
- Modify: `modules/devbox/nixos.nix` (rewrite options + config)
- Modify: `modules/devbox/container.nix:3` (signature), `:29-32` (gh wrapper), `:113-126` (git), `:170` (EnvironmentFile), `:174-196` (password guard + comment)
- Test: `tests/devboxes.nix` (from Task 1, unchanged)

**Interfaces:**
- Consumes: the test from Task 1.
- Produces: `mine.system.devboxes` — `attrsOf submodule` with `githubTokenFile` (path), `paseoPasswordFile` (path), `tailnetHostname` (str), `hostAddress` (str), `localAddress` (str), `gitIdentity.name` (str, default `"BJSummerfield"`), `gitIdentity.email` (str, default `"brianjsummerfield@gmail.com"`). `./container.nix` takes `{ inputs, tailnetHostname, gitIdentity }`.

- [ ] **Step 1: Rewrite `modules/devbox/nixos.nix`**

Header comment becomes per-instance:

```nix
# Persistent coding-agent containers. Security boundary: ssh/sops/signing keys
# stay on the host. Repos live in the container filesystem — GitHub holds the code.
#
# Each attribute of mine.system.devboxes is one container. Once an instance is
# running, join the tailnet and publish paseo once, substituting its attribute
# name for <name>:
# sudo nixos-container root-login <name>
# tailscale up --hostname=<name> --advertise-tags=tag:devbox
# tailscale serve --bg 6767
#
# Reusing tag:devbox across instances keeps one set of tailnet ACLs; a distinct
# tag per instance would need ACL edits on the Tailscale side.
#
# Both are one-time. /var/lib/tailscale is bind-mounted to
# /var/lib/tailscale-<name> on the host, so the node identity and the serve
# config survive container restarts and rebuilds; you only redo this if
# that host directory is wiped. Manual tailscale join — more reliable than
# declarative on nspawn containers.
```

The `let` block and option declaration:

```nix
{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) mapAttrs mapAttrsToList mkIf mkOption types;
  cfg = config.mine.system.devboxes;
  addresses = mapAttrsToList (_: box: box.hostAddress) cfg
    ++ mapAttrsToList (_: box: box.localAddress) cfg;
in
{
  options.mine.system.devboxes = mkOption {
    default = { };
    description = ''
      Coding-agent containers, keyed by container name. Presence in this
      attrset is what enables a container - there is no separate enable
      flag, matching how `containers.*` itself reads.
    '';
    example = lib.literalExpression ''
      {
        devbox = {
          githubTokenFile = config.sops.secrets.devbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
          tailnetHostname = "devbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.26";
          localAddress = "192.168.100.27";
        };
      }
    '';
    type = types.attrsOf (types.submodule {
      options = {
        githubTokenFile = mkOption {
          type = types.path;
          description = ''
            <verbatim from the current file, with the final sentence's
            reference to container.nix retained>
          '';
          example = "/run/secrets/devbox-github-token";
        };

        paseoPasswordFile = mkOption {
          type = types.path;
          description = ''<verbatim from the current file>'';
          example = "/run/secrets/devbox-paseo-password";
        };

        tailnetHostname = mkOption {
          type = types.str;
          description = ''<verbatim from the current file>'';
          example = "devbox.mist-gamma.ts.net";
        };

        hostAddress = mkOption {
          type = types.str;
          description = ''
            Host side of this container's veth pair. Required rather than
            derived: stating it puts every instance's addresses side by
            side in the host config, where a collision is visible.
          '';
          example = "192.168.100.26";
        };

        localAddress = mkOption {
          type = types.str;
          description = ''
            Container side of this container's veth pair. See hostAddress.
          '';
          example = "192.168.100.27";
        };

        gitIdentity = {
          name = mkOption {
            type = types.str;
            default = "BJSummerfield";
            description = "git user.name inside the container.";
          };

          email = mkOption {
            type = types.str;
            default = "brianjsummerfield@gmail.com";
            description = "git user.email inside the container.";
          };
        };
      };
    });
  };
```

**Important:** copy the two long secret descriptions across verbatim from the
current file rather than re-writing them. They carry the reasoning for the
`0440`/`group = "users"` versus root-only `0400` split, which is the most
load-bearing prose in the module. Change only the example paths.

The `config` block:

```nix
  config = mkIf (cfg != { }) {
    assertions =
      mapAttrsToList
        (name: box: {
          # Must be FQDN to match paseo Host-header allowlist.
          assertion = lib.hasInfix "." box.tailnetHostname;
          message = ''
            mine.system.devboxes.${name}.tailnetHostname
            ("${box.tailnetHostname}") must be a fully-qualified tailnet
            hostname (e.g. "devbox.mist-gamma.ts.net"), not a bare node name.
          '';
        })
        cfg
      ++ mapAttrsToList
        (name: _: {
          # ve-<name> is a network interface name, and Linux caps those at 15
          # characters. An over-long name fails when the container starts, not
          # when it is evaluated.
          assertion = builtins.stringLength name <= 12;
          message = ''
            mine.system.devboxes.${name}: instance names may be at most 12
            characters, because the veth interface "ve-${name}" must fit
            Linux's 15-character interface name limit.
          '';
        })
        cfg
      ++ [
        {
          # A duplicate address produces a container that starts cleanly and
          # then cannot route, which reads as a NAT problem rather than a
          # config one.
          assertion = lib.length (lib.unique addresses) == lib.length addresses;
          message = ''
            mine.system.devboxes: hostAddress and localAddress must be unique
            across every instance. Got: ${lib.concatStringsSep ", " addresses}
          '';
        }
      ];

    networking.nat = {
      enable = true;
      internalInterfaces = mapAttrsToList (name: _: "ve-${name}") cfg;
      externalInterface = config.mine.system.externalInterface;
    };

    # Persist each container's tailscale node identity across rebuilds.
    systemd.tmpfiles.rules =
      mapAttrsToList (name: _: "d /var/lib/tailscale-${name} 0700 root root -") cfg;

    containers = mapAttrs
      (name: box: {
        autoStart = true;
        privateNetwork = true;
        inherit (box) hostAddress localAddress;

        allowedDevices = [
          { modifier = "rwm"; node = "/dev/net/tun"; }
        ];

        bindMounts = {
          # needed for tailscale network
          "/dev/net/tun" = {
            hostPath = "/dev/net/tun";
            isReadOnly = false;
          };
          # Persists the tailscale node identity across container restarts
          # and rebuilds. This is what makes the manual `tailscale up` in the
          # header comment a genuinely one-time cost rather than a
          # per-rebuild ritual: wipe this host directory and you re-auth,
          # otherwise you never touch it again.
          "/var/lib/tailscale" = {
            hostPath = "/var/lib/tailscale-${name}";
            isReadOnly = false;
          };
          # Destination paths carry no instance name: they live in this
          # container's own mount namespace, so every instance can use the
          # same two, and container.nix stays free of instance identity.
          "/run/secrets/github-token" = {
            hostPath = box.githubTokenFile;
            isReadOnly = true;
          };
          "/run/secrets/paseo-password" = {
            hostPath = box.paseoPasswordFile;
            isReadOnly = true;
          };
        };

        config = import ./container.nix {
          inherit inputs;
          inherit (box) tailnetHostname gitIdentity;
        };
      })
      cfg;
  };
}
```

Note the stale comment on `autoStart` in the current file ("Flipped to true
only after the sops secrets exist on disk") is dropped — it describes a
migration that already happened and contradicts the `true` beside it.

- [ ] **Step 2: Update `modules/devbox/container.nix`**

Signature (line 3):

```nix
{ inputs, tailnetHostname, gitIdentity }:
```

`ghWrapped` (line 30):

```nix
    export GH_TOKEN=$(cat /run/secrets/github-token)
```

git block (lines 113-126):

```nix
      programs.git = {
        enable = true;
        settings = {
          user = {
            inherit (gitIdentity) name email;
          };
          # Reads the token at use time so it never lands in a config file
          # or the nix store. The token bounds which repos are reachable;
          # a GitHub ruleset is what stops a push to a protected branch.
          credential."https://github.com".helper =
            "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/github-token); }; f";
        };
      };
```

EnvironmentFile (line 170):

```nix
  systemd.services.paseo.serviceConfig.EnvironmentFile = "/run/secrets/paseo-password";
```

Password guard (lines 189-196) — the `grep` path and the message change; the
`+` prefix and the reasoning comment above it stay:

```nix
  systemd.services.paseo.serviceConfig.ExecStartPre = [
    ("+" + toString (pkgs.writeShellScript "paseo-password-check" ''
      if ! ${lib.getExe pkgs.gnugrep} -Eq '^PASEO_PASSWORD=.+' /run/secrets/paseo-password; then
        echo "paseo-password: no non-empty PASEO_PASSWORD=<value> line found - refusing to start paseo unauthenticated (value withheld)" >&2
        exit 1
      fi
    ''))
  ];
```

Also update the prose in the long comment above that guard: the three
occurrences of `devbox-paseo-password` become `paseo-password`, and
`mine.system.devbox.paseoPasswordFile` becomes
`mine.system.devboxes.<name>.paseoPasswordFile`. The reference to "the other
two devbox secrets are bare-value files" stays true and stays as is.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `nix flake check 2>&1 | tail -20`
Expected: `devboxes` passes. `redtruck-eval` FAILS, because
`hosts/redtruck/default.nix` still sets the removed `mine.system.devbox`.
That failure is expected and is fixed in Task 3.

To see just the module test in isolation:
Run: `nix build .#checks.x86_64-linux.devboxes -L`
Expected: builds successfully, no `FAIL:` lines.

- [ ] **Step 4: Commit**

```bash
git add modules/devbox/nixos.nix modules/devbox/container.nix
git commit -m "refactor(devbox): make the container module multi-instance"
```

---

### Task 3: Wire `workbox` onto redtruck

**Files:**
- Modify: `hosts/redtruck/default.nix:16-44` (sops secrets), `:69-80` (`mine.system.devbox` → `devboxes`)
- Test: `tests/devboxes.nix` + the `redtruck-eval` check from Task 1

**Interfaces:**
- Consumes: `mine.system.devboxes` from Task 2.
- Produces: two new sops secret declarations, `workbox-github-token` (mode `0440`, group `users`) and `workbox-paseo-password` (sops-nix defaults).

- [ ] **Step 1: Add the sops secrets**

Extend the existing `sops.secrets` block. Keep the long comment above it; add
a sentence noting it now covers two containers.

```nix
  sops.secrets = {
    devbox-github-token = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0440";
      group = "users";
    };
    devbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
    workbox-github-token = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0440";
      group = "users";
    };
    workbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
  };
```

`.sops.yaml` needs no change: its `secrets/hosts/redtruck\.yaml$` rule already
covers every key in that file.

- [ ] **Step 2: Convert the host's devbox block**

Replace the `devbox = { ... };` entry inside `mine.system` with:

```nix
      devboxes = {
        devbox = {
          githubTokenFile = config.sops.secrets.devbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
          tailnetHostname = "devbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.26";
          localAddress = "192.168.100.27";
        };
        workbox = {
          githubTokenFile = config.sops.secrets.workbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.workbox-paseo-password.path;
          tailnetHostname = "workbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.28";
          localAddress = "192.168.100.29";
        };
      };
```

Keep the existing comment above it about paths coming from the `sops.secrets`
declarations rather than being hardcoded; drop the trailing clause about
`autoStart = false`, which no longer describes the module.

- [ ] **Step 3: Run the full check suite**

Run: `nix flake check 2>&1 | tail -20`
Expected: both `devboxes` and `redtruck-eval` pass.

Then confirm the real host derives what it should:

Run: `nix eval --json '.#nixosConfigurations.redtruck.config.networking.nat.internalInterfaces'`
Expected: `["ve-devbox","ve-workbox"]`

Run: `nix eval --json '.#nixosConfigurations.redtruck.config.containers.workbox.bindMounts."/run/secrets/github-token".hostPath'`
Expected: `"/run/secrets/workbox-github-token"`

- [ ] **Step 4: Commit**

```bash
git add hosts/redtruck/default.nix
git commit -m "feat(redtruck): add second coding-agent container (workbox)"
```

---

### Task 4: Record the operator steps

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-second-devbox-design.md` (no change — reference only)
- Modify: `New_Host.md` only if it documents the devbox ritual (check first; if it does not mention devbox, skip this file and make no change)

**Interfaces:**
- Consumes: everything above. Produces nothing consumed by other tasks.

- [ ] **Step 1: Check whether the ritual is documented outside the module**

Run: `grep -n "devbox\|tailscale up" New_Host.md`
Expected: if there are no hits, this task's only remaining work is Step 2's
manual checklist — make no file change and skip to Step 3.

If there are hits, add `workbox` alongside `devbox` in the same style the file
already uses.

- [ ] **Step 2: Hand the operator the manual steps**

These cannot be automated and are not part of any commit. Report them verbatim
to the user:

```
# 1. Add the two secrets (on a machine with the sops age key):
sops secrets/hosts/redtruck.yaml
#    workbox-github-token: <fine-grained PAT, bare value>
#    workbox-paseo-password: PASEO_PASSWORD=<secret>
#    The PASEO_PASSWORD= prefix is required — the container's ExecStartPre
#    guard refuses to start paseo without it.

# 2. Rebuild redtruck. The existing devbox container restarts once (its
#    bind-mount destinations renamed); its tailnet identity survives in
#    /var/lib/tailscale-devbox, so there is no re-auth.

# 3. One-time tailnet join for the new container:
sudo nixos-container root-login workbox
tailscale up --hostname=workbox --advertise-tags=tag:devbox
tailscale serve --bg 6767
```

- [ ] **Step 3: Commit (only if Step 1 changed a file)**

```bash
git add New_Host.md
git commit -m "docs: note the second coding-agent container"
```
