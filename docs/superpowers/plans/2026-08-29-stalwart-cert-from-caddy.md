# Stalwart Certificate From Caddy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make caddy the sole issuer of `mx1.brianjs.com`, publish that certificate to a stable directory the Stalwart container reads, and reload Stalwart whenever caddy renews it.

**Architecture:** A generic `mine.system.caddy.certExports` registry on the edge module copies a claimed hostname's certificate out of caddy's storage into a stable directory, then runs a consumer-supplied `postPublish` command. A `systemd.path` watches caddy's certificate directory, with a daily timer as backstop. The stalwart module registers an export, bind-mounts the destination read-only into its container, and supplies a `postPublish` that reloads Stalwart over its management API, restarts on failure, and verifies the served certificate matches the published file.

**Tech Stack:** NixOS configuration (flake), nixpkgs at pin `9fbb54b33e91ee4ca368e35a78e0613c720600b3`, stalwart 0.15.5, stock caddy 2.11.4, sops-nix, systemd path/timer units.

**Spec:** `docs/superpowers/specs/2026-08-29-stalwart-cert-from-caddy-design.md`

## Global Constraints

- **Do not bump the nixpkgs pin.** `9fbb54b33e91ee4ca368e35a78e0613c720600b3`.
- **The VPS must never compile caddy or stalwart.** Both substitute from `cache.nixos.org`. No `passthru.cache` marker goes on either.
- **Format before committing:** the repo formats with nixfmt-tree via `nix fmt` (devShell).
- **Deploy only after CI is green and the `verified` ref has advanced.** Rollback is `sudo nixos-rebuild switch --rollback` on the VPS.
- **Out of scope (do not touch):** the `brianjs.com` apex (no A record, unclaimed by design), the mail-port forwards (25/465/993), photoform, caddy's own ACME configuration, and Stalwart's listener binds.
- **Two steps are DB-managed and stay manual:** creating the API key, and pointing Stalwart's TLS at the PEM files while disabling its ACME provider. Task 4 covers them.

## Refinement of the spec

The spec says the publish step copies "with the right ownership" without saying how the container's `stalwart-mail` user gets read access. That user's uid is allocated dynamically by NixOS and is not knowable at eval time, and changing it would require chowning a live mail store.

**Decision:** a static *group*. Both host and container declare `stalwart-certs` with the same numeric gid; the container adds `stalwart-mail` to it. Published files are `root:stalwart-certs` mode `0640`. Nothing about the existing uid changes.

`LoadCredential` was considered and rejected: credentials are materialised at unit start, so a graceful reload would re-read a stale copy and only a restart would help — defeating the whole point of the reload path.

---

### Task 1: The `certExports` registry on the caddy edge

**Files:**
- Modify: `modules/caddy/nixos.nix`
- Create: `tests/stalwart.nix`
- Modify: `flake.nix:112-121` (register the new check)

**Interfaces:**
- Produces: option `mine.system.caddy.certExports.<name>` with exactly `{ hostname: str; destination: path; owner: str; group: str; postPublish: lines (default "") }`. For each export: a oneshot `systemd.services."caddy-cert-export-<name>"`, a `systemd.paths."caddy-cert-export-<name>"` watching caddy's certificate directory, and a daily `systemd.timers."caddy-cert-export-<name>"`. Published filenames are exactly `cert.pem` and `key.pem` inside `destination`.
- Consumes: `config.services.caddy.dataDir` from nixpkgs (defaults to `/var/lib/caddy`).

- [ ] **Step 1: Write the failing test**

Create `tests/stalwart.nix`:

```nix
# Pure-evaluation checks binding the stalwart container to the caddy edge's
# certificate export. Stalwart's own ACME cannot renew while caddy terminates
# :443, so the published certificate and the reload that follows it are the
# only thing standing between a renewal and expired mail TLS on 25/465/993.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  mkHost =
    extra:
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/backups/nixos.nix
        ../modules/caddy/nixos.nix
        ../modules/stalwart-server/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine = {
            system = {
              hostName = "stalwart-test";
              externalInterface = "eth0";
              stalwart-server = {
                enable = true;
                adminPasswordFile = "/dev/null";
                apiKeyFile = "/dev/null";
              };
            };
            backups = {
              enable = true;
              repository = "s3:example/test";
              repoPasswordFile = "/dev/null";
              b2EnvFile = "/dev/null";
            };
          };
        }
        extra
      ];
    }).config;

  # The mail route lives in hosts/vps, not the module, so the test supplies it.
  host = mkHost {
    mine.system.caddy = {
      enable = true;
      acmeEmail = "test@example.com";
      routes.mail = {
        hostnames = [ "mx1.brianjs.com" ];
        target = "https://192.168.100.41:443";
      };
    };
  };

  # Same, but no route claims the exported hostname.
  unclaimed = mkHost {
    mine.system.caddy = {
      enable = true;
      acmeEmail = "test@example.com";
    };
  };

  export = host.mine.system.caddy.certExports.stalwart;
  publish = host.systemd.services."caddy-cert-export-stalwart";

  checks = [
    {
      name = "the stalwart module registers a cert export for the mail hostname";
      ok = export.hostname == "mx1.brianjs.com" && export.destination == "/var/lib/stalwart-certs";
    }
    {
      # root:stalwart-certs 0640 — the container's stalwart-mail uid is
      # allocated dynamically and is not knowable at eval time, so read access
      # comes from a static gid shared by host and container instead.
      name = "the export publishes as root:stalwart-certs";
      ok = export.owner == "root" && export.group == "stalwart-certs";
    }
    {
      name = "a path unit and a backstop timer both drive the publish service";
      ok =
        host.systemd.paths ? "caddy-cert-export-stalwart"
        && host.systemd.timers ? "caddy-cert-export-stalwart";
    }
    {
      name = "the publish service watches caddy's real certificate directory";
      ok = lib.hasInfix "acme-v02.api.letsencrypt.org-directory/mx1.brianjs.com" (
        builtins.head host.systemd.paths."caddy-cert-export-stalwart".pathConfig.PathChanged
      );
    }
    {
      # An unclaimed hostname would publish nothing, silently: caddy only
      # obtains certificates for names it serves.
      name = "an export whose hostname no route claims fails the assertion";
      ok = lib.any (
        a: !a.assertion && lib.hasInfix "claimed by no route" a.message
      ) unclaimed.assertions;
    }
    {
      name = "the publish service is a oneshot ordered after caddy";
      ok = publish.serviceConfig.Type == "oneshot" && lib.elem "caddy.service" publish.after;
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "stalwart-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
```

Register it in `flake.nix`, directly after the `photoform` entry (line 117-120):

```nix
          stalwart = import ./tests/stalwart.nix {
            inherit nixpkgs inputs;
            system = "x86_64-linux";
          };
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nix build .#checks.x86_64-linux.stalwart --print-build-logs`
Expected: FAIL — evaluation errors on the undefined options `mine.system.caddy.certExports` and `mine.system.stalwart-server.apiKeyFile`. This is an eval failure, not a `FAIL:` line; the named checks only start reporting once Task 2 defines the options.

- [ ] **Step 3: Add the registry option to the caddy module**

In `modules/caddy/nixos.nix`, inside `options.mine.system.caddy`, after the `routes` option:

```nix
    certExports = lib.mkOption {
      default = { };
      description = ''
        Certificates to copy out of caddy's storage for another service to
        read. Registered by service modules guarded on this module's enable,
        so registrations are inert on hosts without an edge.

        Caddy owns the storage layout: the path embeds both caddy's internal
        directory structure and the ACME directory URL, so a consumer that
        mounted it directly would break on a CA change.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            hostname = lib.mkOption {
              type = lib.types.str;
              example = "mx1.brianjs.com";
              description = "A hostname claimed by one of the routes above.";
            };
            destination = lib.mkOption {
              type = lib.types.path;
              example = "/var/lib/stalwart-certs";
              description = ''
                Directory to publish `cert.pem` and `key.pem` into.
              '';
            };
            owner = lib.mkOption {
              type = lib.types.str;
              default = "root";
              description = "Owner of the published files.";
            };
            group = lib.mkOption {
              type = lib.types.str;
              description = ''
                Group of the published files, which are mode 0640. Consumers
                running as another user read them via group membership.
              '';
            };
            postPublish = lib.mkOption {
              type = lib.types.lines;
              default = "";
              description = ''
                Shell run after a successful copy — typically telling the
                consumer to re-read the certificate. Runs as root on the host.
                A non-zero exit fails the publish unit.
              '';
            };
          };
        }
      );
    };
```

- [ ] **Step 4: Add the assertion and the units**

In `modules/caddy/nixos.nix`, add to the existing `let` block above `routeBody`:

```nix
  # Caddy's on-disk layout. The ACME-directory segment is derived from the
  # CA URL; this module never sets a custom CA, so Let's Encrypt production
  # is the only value it can take.
  certDirFor =
    h:
    "${config.services.caddy.dataDir}/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${h}";

  claimedHostnames = lib.concatMap (r: r.hostnames) (lib.attrValues cfg.routes);
```

Add to the existing `assertions` list:

```nix
      {
        assertion = lib.all (e: lib.elem e.hostname claimedHostnames) (lib.attrValues cfg.certExports);
        message = "mine.system.caddy: a cert export names a hostname claimed by no route, so caddy would never obtain it";
      }
```

Add to `config`, after the `services.caddy` block:

```nix
    # One publish unit per export. The path unit catches a renewal within
    # seconds; the timer is the backstop, on the same reasoning as
    # systemd.timers.devbox-warm — a missed inotify event here is cheap to
    # guard against and expensive to suffer, because the failure is an
    # expired certificate on mail ports that bypass caddy entirely.
    systemd.services = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Publish caddy's ${e.hostname} certificate to ${e.destination}";
        after = [ "caddy.service" ];
        wants = [ "caddy.service" ];
        serviceConfig.Type = "oneshot";
        path = [
          pkgs.coreutils
          pkgs.openssl
        ];
        script = ''
          set -euo pipefail
          install -d -m 0750 -o ${e.owner} -g ${e.group} ${e.destination}
          install -m 0640 -o ${e.owner} -g ${e.group} \
            ${certDirFor e.hostname}/${e.hostname}.crt ${e.destination}/cert.pem
          install -m 0640 -o ${e.owner} -g ${e.group} \
            ${certDirFor e.hostname}/${e.hostname}.key ${e.destination}/key.pem
          ${e.postPublish}
        '';
      }
    ) cfg.certExports;

    systemd.paths = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Watch caddy's ${e.hostname} certificate for renewal";
        wantedBy = [ "multi-user.target" ];
        pathConfig.PathChanged = [ (certDirFor e.hostname) ];
      }
    ) cfg.certExports;

    systemd.timers = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Backstop republish of caddy's ${e.hostname} certificate";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = "daily";
          Persistent = true;
        };
      }
    ) cfg.certExports;

    users.groups = lib.mapAttrs' (
      _: e: lib.nameValuePair e.group { }
    ) cfg.certExports;
```

- [ ] **Step 5: Run the test**

Run: `nix build .#checks.x86_64-linux.stalwart --print-build-logs`
Expected: still FAIL, now on `mine.system.stalwart-server.apiKeyFile` being undefined. The caddy half is done; Task 2 finishes it.

- [ ] **Step 6: Commit**

```bash
nix fmt
git add modules/caddy/nixos.nix tests/stalwart.nix flake.nix
git commit -m "feat(caddy): add a certExports registry for edge-issued certificates"
```

---

### Task 2: Stalwart consumes the published certificate

**Files:**
- Modify: `modules/stalwart-server/nixos.nix`

**Interfaces:**
- Consumes: `mine.system.caddy.certExports.<name>` from Task 1, with published filenames `cert.pem` and `key.pem`.
- Produces: option `mine.system.stalwart-server.apiKeyFile` (type `path`); a `stalwart` cert export publishing to `/var/lib/stalwart-certs` as `root:stalwart-certs`; a read-only bind mount of that directory at the same path inside the container; container group `stalwart-certs` with gid `700`, with `stalwart-mail` a member.

- [ ] **Step 1: Add the API key option**

In `modules/stalwart-server/nixos.nix`, after the existing `adminPasswordFile` option:

```nix
    apiKeyFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Host path to a Stalwart API key with the "Refresh system settings"
        permission, used to reload TLS certificates after caddy renews them.
        Created in the admin UI; Stalwart's API keys are DB-managed and
        cannot be declared here.
      '';
    };
```

- [ ] **Step 2: Add the shared group and the mail hostname binding**

Add to the module's top-level `let` block, next to `hostStateDir`:

```nix
  certDir = "/var/lib/stalwart-certs";
  # The hostname Stalwart presents on every listener, and the name caddy
  # obtains the shared certificate for.
  mailHostname = "mx1.brianjs.com";
  # Static so the host can chgrp published files to a group the container
  # resolves to the same number. stalwart-mail's uid is allocated
  # dynamically and changing it would mean chowning a live mail store.
  certGid = 700;
```

- [ ] **Step 3: Register the export**

Add to `config`, alongside the existing `mine.backups` registration:

```nix
    # Caddy is the sole issuer for the mail hostname: Stalwart's own
    # TLS-ALPN-01 cannot complete while caddy terminates :443, and its
    # certificate still serves 25/465/993, which bypass caddy entirely.
    mine.system.caddy.certExports = lib.mkIf config.mine.system.caddy.enable {
      stalwart = {
        hostname = mailHostname;
        destination = certDir;
        owner = "root";
        group = "stalwart-certs";
        # Reload in-place rather than restarting: this runs on every renewal
        # and a restart drops live IMAP and SMTP connections. The management
        # listener is plain HTTP on the container's loopback, so rotating TLS
        # never depends on a TLS connection secured by the certificate being
        # replaced.
        postPublish = ''
          if ! ${pkgs.nixos-container}/bin/nixos-container run stalwart -- \
              ${pkgs.curl}/bin/curl --fail --silent --show-error \
                -H "Authorization: Bearer $(cat ${cfg.apiKeyFile})" \
                http://127.0.0.1:8080/api/reload/certificate; then
            echo "certificate reload failed; restarting stalwart" >&2
            systemctl restart container@stalwart
          fi

          # Verify rather than assume. A reload that silently did not take
          # leaves Stalwart serving the old certificate from memory until it
          # expires — the exact silent failure this whole change exists to
          # remove. Source address is the veth gateway, which must stay
          # allow-listed in Stalwart's security settings.
          served=$(openssl s_client -connect 192.168.100.41:443 \
            -servername ${mailHostname} </dev/null 2>/dev/null \
            | openssl x509 -noout -fingerprint -sha256)
          ondisk=$(openssl x509 -in ${certDir}/cert.pem -noout -fingerprint -sha256)
          if [ "$served" != "$ondisk" ]; then
            echo "stalwart is not serving the published certificate" >&2
            echo "  served: $served" >&2
            echo "  ondisk: $ondisk" >&2
            exit 1
          fi
        '';
      };
    };
```

- [ ] **Step 4: Mount it into the container**

Add to `containers.stalwart.bindMounts`:

```nix
        # Read-only: caddy renews, the host publishes, Stalwart only reads.
        "${certDir}" = {
          hostPath = certDir;
          isReadOnly = true;
        };
```

And inside the container's config, next to the existing `networking` block:

```nix
          # Matches the host's gid so the bind-mounted 0640 files are readable
          # without knowing stalwart-mail's dynamically-allocated uid.
          users.groups.stalwart-certs.gid = certGid;
          users.users.stalwart-mail.extraGroups = [ "stalwart-certs" ];
```

Set the same gid on the host by adding to `config`:

```nix
    users.groups.stalwart-certs.gid = certGid;
```

- [ ] **Step 5: Run the test**

Run: `nix build .#checks.x86_64-linux.stalwart --print-build-logs`
Expected: PASS — all six checks. If `the export publishes as root:stalwart-certs` fails, the group name in Step 3 does not match the test.

- [ ] **Step 6: Verify the whole flake still evaluates**

Run: `nix flake check --print-build-logs`
Expected: PASS, including `caddyfile-vps` (the Caddyfile is unchanged by this task, so a failure here means a typo in the caddy module) and `nixos-vps` — which will still fail until Task 3 supplies `apiKeyFile`. That failure is expected at this point.

- [ ] **Step 7: Commit**

```bash
nix fmt
git add modules/stalwart-server/nixos.nix
git commit -m "feat(stalwart): consume caddy's certificate and reload on renewal"
```

---

### Task 3: Host wiring

**Files:**
- Modify: `hosts/vps/default.nix:44-54` (sops secrets), `hosts/vps/default.nix` (stalwart-server block)
- Modify: `secrets/hosts/vps.yaml`

**Interfaces:**
- Consumes: `mine.system.stalwart-server.apiKeyFile` from Task 2.
- Produces: `sops.secrets.stalwart-api-key`, wired to that option.

- [ ] **Step 1: Confirm the gid is free on the VPS**

Run on the VPS: `getent group 700; sudo nixos-container run stalwart -- getent group 700`
Expected: no output from either. If either prints a group, pick another gid below 900 that is free on both and update `certGid` in `modules/stalwart-server/nixos.nix` and the comment in `tests/stalwart.nix`.

- [ ] **Step 2: Add the secret**

Run: `nix develop -c sops secrets/hosts/vps.yaml` and add a `stalwart-api-key` key. Leave the value as a placeholder for now — Task 4 Step 2 creates the real key and replaces it.

Then in `hosts/vps/default.nix`, after the existing `stalwart-admin-pw` declaration:

```nix
  sops.secrets.stalwart-api-key = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
```

- [ ] **Step 3: Wire it to the module**

In `hosts/vps/default.nix`, in the `stalwart-server` block next to `adminPasswordFile`:

```nix
        apiKeyFile = config.sops.secrets.stalwart-api-key.path;
```

- [ ] **Step 4: Verify the host evaluates**

Run: `nix flake check --print-build-logs`
Expected: PASS, all checks including `nixos-vps` and `stalwart`.

- [ ] **Step 5: Commit and open the PR**

```bash
nix fmt
git add hosts/vps/default.nix secrets/hosts/vps.yaml
git commit -m "feat(vps): wire the stalwart API key for certificate reloads"
git push -u origin plan/stalwart-cert-from-caddy
gh pr create --fill
```

---

### Task 4: Deploy and cut over

Operator task, on the VPS and in Stalwart's admin UI. Prerequisite: Task 3's PR merged, CI green, `verified` advanced.

**Interfaces:**
- Consumes: the merged configuration.
- Produces: Stalwart serving caddy's certificate on 25/465/993, with its own ACME disabled.

**Rollback:** `sudo nixos-rebuild switch --rollback`. Stalwart's ACME settings are DB-managed, so re-enabling the ACME provider in the UI is a separate undo — do that first if the certificate itself is the problem.

- [ ] **Step 1: Record the current certificate**

```sh
curl -v --max-time 5 https://192.168.100.41:443/ 2>&1 | grep -Ei 'expire date|issuer:'
```

Expected: the certificate Stalwart currently serves, from its own TLS-ALPN-01 ACME. Note the expiry — it is the deadline this whole change exists to beat, and the value to compare against after cutover.

- [ ] **Step 2: Create the API key**

In the admin UI, create an API key with the **"Refresh system settings"** permission. Put the real value into `secrets/hosts/vps.yaml` (`nix develop -c sops secrets/hosts/vps.yaml`), commit, and let CI go green before deploying.

- [ ] **Step 3: Deploy**

```sh
sudo nixos-rebuild switch --flake github:BJSummerfield/nixcfg/verified#vps
```

Expected: success with no local compilation. The publish unit runs on activation via its path unit; the reload will fail harmlessly at this point because Stalwart is still using its own ACME certificate and the fingerprints will not match. That is expected until Step 4.

- [ ] **Step 4: Point Stalwart at the published files**

In the admin UI, configure the TLS certificate to load from:

```
/var/lib/stalwart-certs/cert.pem
/var/lib/stalwart-certs/key.pem
```

Then **disable the ACME provider** so Stalwart stops attempting TLS-ALPN-01. Save and reload.

- [ ] **Step 5: Confirm the container can actually read the files**

```sh
sudo nixos-container run stalwart -- ls -l /var/lib/stalwart-certs/
sudo nixos-container run stalwart -- sudo -u stalwart-mail cat /var/lib/stalwart-certs/key.pem > /dev/null && echo readable
```

Expected: both files `root stalwart-certs` mode `-rw-r-----`, and `readable`. A permission error here means the gid did not match between host and container — check `getent group stalwart-certs` on both.

- [ ] **Step 6: Force a republish and confirm the full path works**

```sh
sudo systemctl start caddy-cert-export-stalwart
sudo systemctl status caddy-cert-export-stalwart --no-pager
```

Expected: the unit succeeds. This exercises copy → reload → verify end to end, which is the point: waiting 60 days to discover the reload path is broken is exactly the failure mode being designed out.

- [ ] **Step 7: Confirm Stalwart serves caddy's certificate**

```sh
curl -v --max-time 5 https://192.168.100.41:443/ 2>&1 | grep -Ei 'expire date|issuer:'
sudo openssl x509 -in /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mx1.brianjs.com/mx1.brianjs.com.crt -noout -fingerprint -sha256
```

Expected: the served certificate's dates now match caddy's, not the old ACME one recorded in Step 1.

- [ ] **Step 8: Confirm mail still works**

From a real client: send and fetch a message over IMAP 993, and check the certificate presented there is the new one. These ports bypass caddy entirely and are the reason this change exists — a green webmail page proves nothing about them.

- [ ] **Step 9: Confirm the backstop**

```sh
systemctl list-timers caddy-cert-export-stalwart --no-pager
```

Expected: a daily timer, next elapse within 24h.

---

## Self-Review

- **Spec coverage:** `certExports` registry with hostname/destination/owner/group/postPublish (Task 1 Step 3) ✓; assertion on unclaimed hostnames (Task 1 Step 4, tested Task 1 Step 1) ✓; publish unit + path watch + daily backstop timer (Task 1 Step 4) ✓; stable destination rather than mounting caddy's storage (Task 1 Step 4, `certDirFor` confined to the caddy module) ✓; bind mount read-only into the container (Task 2 Step 4) ✓; reload via management API from inside the container (Task 2 Step 3) ✓; restart fallback (Task 2 Step 3) ✓; fingerprint verification failing loudly (Task 2 Step 3) ✓; sops API key (Task 3) ✓; operator steps for the DB-managed TLS config and ACME disable (Task 4 Steps 2 and 4) ✓; eval tests following `tests/photoform.nix` (Task 1 Step 1) ✓.
- **Spec gap closed:** the spec did not say how the container reads the key. Resolved above under "Refinement of the spec" with a static gid, and tested in Task 1.
- **Placeholder scan:** every step carries exact file paths, complete Nix, or exact commands with expected output. No "TBD" or "similar to Task N".
- **Type consistency:** `certExports.<name>` is written by the stalwart module (Task 2 Step 3) and read by the caddy module (Task 1 Steps 3-4) with the same five attribute names; published filenames are `cert.pem`/`key.pem` in Task 1 Step 4, Task 2 Step 3's verification, and Task 4 Step 4; `certGid = 700` is used in Task 2 Steps 2 and 4 and checked in Task 3 Step 1; unit name `caddy-cert-export-stalwart` matches across Task 1's test, Task 1 Step 4's `nameValuePair`, and Task 4 Steps 6 and 9.
- **Known gap, carried from the spec:** a failed publish unit is visible in `systemctl --failed` and re-asserted daily, but nothing pages. Closing that needs alerting infrastructure this repo does not have, and is deliberately out of scope.
