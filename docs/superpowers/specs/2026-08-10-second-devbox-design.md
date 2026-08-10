# Second Devbox Container (`workbox`)

## Problem

`redtruck` runs one coding-agent container, `devbox`, defined by the singleton
option `mine.system.devbox` in `modules/devbox/nixos.nix`. A second, identical
container is needed, differing only in which GitHub fine-grained PAT it uses —
a different sops secret, pointing at a different repository allowlist.

The current module cannot express a second instance. Everything is hardcoded to
the single name: `containers.devbox`, the NAT internal interface `ve-devbox`,
the veth pair `192.168.100.26`/`.27`, the tailscale state directory
`/var/lib/tailscale-devbox`, and the in-container secret paths
`/run/secrets/devbox-github-token` and `/run/secrets/devbox-paseo-password`.

## Goal

Turn `mine.system.devbox` into a multi-instance option, add a second instance
named `workbox` on the same host, and expose the container's git identity as a
per-instance option. No behavioural change to the existing `devbox` container
beyond a single restart.

## Design

### 1. `mine.system.devboxes` — attrset of instances

`modules/devbox/nixos.nix` drops its `enable` flag and becomes an attrset keyed
by container name, following the `types.attrsOf (types.submodule ...)` pattern
already used in `modules/filesystems/nas.nix`:

```nix
options.mine.system.devboxes = mkOption {
  type = types.attrsOf (types.submodule { options = { ... }; });
  default = { };
};
```

Presence in the attrset means enabled — there is no per-instance `enable`, which
matches how `containers.*` itself reads. The `config` block becomes
`mkIf (cfg != { })`, and each formerly-single value becomes a fold over the
attrset:

- `containers = mapAttrs (name: box: { ... }) cfg;` — the full container block,
  taking `hostAddress`/`localAddress` from the instance and passing
  `tailnetHostname` and `gitIdentity` into `./container.nix`.
- `networking.nat.internalInterfaces = mapAttrsToList (name: _: "ve-${name}") cfg;`
  — one NAT block listing every instance's veth, rather than one block per
  instance.
- `systemd.tmpfiles.rules =
  mapAttrsToList (name: _: "d /var/lib/tailscale-${name} 0700 root root -") cfg;`
- `assertions` — generated per instance with `mapAttrsToList`, plus one
  whole-attrset uniqueness check (section 3).

The module's header comment is rewritten: the one-time tailnet ritual is now
per-container, so `nixos-container root-login devbox` becomes
`nixos-container root-login <name>`.

### 2. Per-instance options

| Option | Type | Default |
|---|---|---|
| `githubTokenFile` | `types.path` | required |
| `paseoPasswordFile` | `types.path` | required |
| `tailnetHostname` | `types.str` | required |
| `hostAddress` | `types.str` | required |
| `localAddress` | `types.str` | required |
| `gitIdentity.name` | `types.str` | `"BJSummerfield"` |
| `gitIdentity.email` | `types.str` | `"brianjsummerfield@gmail.com"` |

`githubTokenFile` and `paseoPasswordFile` keep their existing long descriptions
verbatim except for the example paths. The reasoning they carry — that the token
must be `mode = "0440"`, `group = "users"` because the agent reads it as uid
1500 under `PRIVATE_USERS=no` and sops-nix's `owner` cannot name that uid, while
the paseo password stays root-only `0400` because PID 1 reads it via
`EnvironmentFile=` before dropping to `User=agent` — applies unchanged to every
instance and becomes more load-bearing with two of them.

`hostAddress` and `localAddress` are required rather than defaulted. They are
implicit today; making each host state them puts both instances' addresses
side by side in `hosts/redtruck/default.nix`, where a collision is visible.

`gitIdentity` is a `types.submodule` with `name` and `email`, mapping directly
onto `user.name` / `user.email` in the container's `programs.git.settings`. It
defaults to the values currently hardcoded in `container.nix`, so an instance
that does not care never mentions it.

### 3. Assertions

Three checks, all at eval time:

1. **FQDN** (existing, now per instance): `tailnetHostname` must contain a dot,
   because it feeds paseo's Host-header allowlist and must match what
   `tailscale serve` publishes. A mismatch produces HTTP 400s.
2. **Name length** (new): `ve-${name}` must fit Linux's 15-character network
   interface limit, so an instance name may be at most 12 characters.
3. **Address uniqueness** (new): no two instances may share a `hostAddress` or
   a `localAddress`. Without this, a typo produces a container that starts
   cleanly but cannot route, which reads as a NAT problem rather than a config
   one.

### 4. `container.nix` changes

Exactly two:

- It takes `gitIdentity` alongside `tailnetHostname`, and uses it in
  `programs.git.settings.user`.
- The three references to `/run/secrets/devbox-github-token` and
  `/run/secrets/devbox-paseo-password` become `/run/secrets/github-token` and
  `/run/secrets/paseo-password`.

The rename is safe and desirable: those paths are bind-mount *destinations*
inside each container's own mount namespace, so both containers can use the same
names. Only the host-side source paths differ. This keeps `container.nix`
entirely free of instance identity.

Nothing else in the file changes. The agent uid, the paseo unit and its
`ExecStartPre` password guard, the `devbox-warm` service/path/timer units, the
firewall, and the nix registry pin are all namespace-private and stay
byte-identical across instances.

### 5. Host wiring

`hosts/redtruck/default.nix` gains two sops entries mirroring the existing pair:

```nix
sops.secrets = {
  devbox-github-token  = { sopsFile = ../../secrets/hosts/redtruck.yaml; mode = "0440"; group = "users"; };
  devbox-paseo-password.sopsFile  = ../../secrets/hosts/redtruck.yaml;
  workbox-github-token = { sopsFile = ../../secrets/hosts/redtruck.yaml; mode = "0440"; group = "users"; };
  workbox-paseo-password.sopsFile = ../../secrets/hosts/redtruck.yaml;
};
```

`.sops.yaml` needs no change — its `secrets/hosts/redtruck\.yaml$` rule already
covers the whole file. The two values are added with
`sops secrets/hosts/redtruck.yaml`: the token as a bare value, the password as
the literal string `PASEO_PASSWORD=<secret>`, since the container's
`ExecStartPre` guard refuses to start paseo otherwise.

The existing `mine.system.devbox = { ... }` block becomes:

```nix
mine.system.devboxes = {
  devbox = {
    githubTokenFile   = config.sops.secrets.devbox-github-token.path;
    paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
    tailnetHostname   = "devbox.mist-gamma.ts.net";
    hostAddress       = "192.168.100.26";
    localAddress      = "192.168.100.27";
  };
  workbox = {
    githubTokenFile   = config.sops.secrets.workbox-github-token.path;
    paseoPasswordFile = config.sops.secrets.workbox-paseo-password.path;
    tailnetHostname   = "workbox.mist-gamma.ts.net";
    hostAddress       = "192.168.100.28";
    localAddress      = "192.168.100.29";
  };
};
```

`devbox` keeps its current addresses verbatim. Neither instance sets
`gitIdentity`, so both use the default. The existing comment above the sops
block — explaining why the two secret modes point opposite ways — stays.

## Testing

The repo has no test infrastructure today; this adds the first `checks` output.

The risk this change introduces is narrow: hardcoded strings become derived
ones, and the failure mode is a value derived wrong or dropped. That is all
visible at eval time, so the tests are pure evaluation — no VM.

`tests/devboxes.nix` evaluates a minimal `nixpkgs.lib.nixosSystem` importing only
`modules/system/nixos.nix` (which defines `mine.system.externalInterface`) and
`modules/devbox/nixos.nix`, plus stub `fileSystems`, `boot.loader`, and
`system.stateVersion`. It does not import `modules/nixos.nix`, so the check stays
fast and pulls in nothing unrelated. With two instances declared, it asserts:

- `containers.devbox` and `containers.workbox` both exist, with the
  `hostAddress`/`localAddress` they were given
- `networking.nat.internalInterfaces` contains exactly `ve-devbox` and
  `ve-workbox`
- `systemd.tmpfiles.rules` contains both `/var/lib/tailscale-devbox` and
  `/var/lib/tailscale-workbox`
- each container's bind mounts map its own host token path onto the shared
  `/run/secrets/github-token`
- the container's `programs.git.settings.user` picks up the default identity
  when `gitIdentity` is unset, and the overridden one when it is set

A second check, `redtruck-eval`, forces
`nixosConfigurations.redtruck.config.system.build.toplevel.drvPath`. This is
evaluation only, not a build, and is what catches the migration breaking the
real host.

Both are wired into a new `checks = forAllSystems (...)` block in `flake.nix` and
run with `nix flake check`.

**Deliberately not tested:** a `nixosTest` VM booting both containers. It would
build tailscale, paseo, home-manager, and unfree `claude-code`, and the only
things it could uniquely verify — that the tailnet join succeeds and
`tailscale serve` publishes — are exactly the manual steps this design keeps
out of Nix.

Negative assertion cases (duplicate address, bare hostname, over-long name) are
not covered by automated tests. The assertions themselves ship; only their
test coverage is skipped.

## Migration

The existing `devbox` container restarts once on the next rebuild, because its
bind-mount destinations rename. Its tailnet identity survives — that lives in
`/var/lib/tailscale-devbox`, which is untouched — so there is no re-auth.

`workbox` then needs the same one-time ritual the header comment already
documents:

```
sudo nixos-container root-login workbox
tailscale up --hostname=workbox --advertise-tags=tag:devbox
tailscale serve --bg 6767
```

Reusing `tag:devbox` means the existing tailnet ACLs apply unchanged; a separate
tag would require ACL edits on the Tailscale side.
