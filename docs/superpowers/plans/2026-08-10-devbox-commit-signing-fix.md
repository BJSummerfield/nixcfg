# Devbox Commit Signing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make git commits inside the devbox container SSH-signed, replacing the broken ssh-agent implementation in commit `4075505` (PR #93) with a direct key-file setup that actually evaluates, deploys, and signs.

**Architecture:** Git's SSH signing shells out to `ssh-keygen -Y sign -f <keyfile>`. That takes a **key file path, not an agent socket** — so the entire `ssh-agent-devbox` systemd unit, its socket, the `ssh_config`, and the `SSH_AUTH_SOCK` plumbing are unnecessary and get deleted. What replaces them is three lines: `user.signingkey` pointed at the bind-mounted sops secret, plus `uid = 1500` on the sops secret so OpenSSH's private-key permission check passes.

**Tech Stack:** Nix, NixOS containers (nspawn), sops-nix, Home Manager, OpenSSH

## Global Constraints

- **OpenSSH's private-key check is the binding constraint.** `ssh-keygen -Y sign` refuses a private key unless the file is owned by the calling uid (or root) **and** has zero group/other permission bits. Verified empirically: mode `0440` → `Permissions 0440 for 'k' are too open ... This private key will be ignored`; mode `0400` owned by uid 1500 → signs successfully. So the `mode = "0440"; group = "users";` pattern used for `devbox-github-token` **cannot** be reused here.
- **`sops-nix` `owner` cannot name uid 1500** — it takes a host username and no host user has that uid. Use the numeric `uid` option instead; sops-nix documents that "the UID will be applied even if the corresponding user doesn't exist". Setting `uid` requires `owner` to stay `null` (sops-nix assertion at `modules/sops/default.nix:451`).
- **The old keypair is burned.** Its private half was printed into an agent session transcript. Generate a fresh key on redtruck; never reuse `SHA256`-anything from `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOiEuEmaJONbC6vFwlVYO9OgiIylhMmqi+xC5muRIn1Y devbox@peachy-husky`.
- **Order matters: secret before rebuild.** `containers.devbox.autoStart = true` and a `bindMount` whose `hostPath` is missing fails at *container start*, not at build. Task 1 (create the secret) must land before Task 3 (deploy), or `container@devbox` will fail to start and take the working PAT-based setup down with it.
- **Never hand-edit `secrets/hosts/redtruck.yaml`.** Every value is covered by a MAC over the whole file. The current `PLACEHOLDER` line is not merely MAC-invalid, it is not even parseable YAML (verified: `yq` reports `did not find expected key, line 2, column 64` — the double-quoted scalar contains unescaped `"`). Only `sops` may write this file.
- sops CLI on hand is `3.13.3`; use `sops set <file> <index> --value-file <path>` so the key never appears in a process listing.
- Comment style follows the repo convention already in these files: blunt reasons, no restating of what the code says.

---

### Task 1: Restore the secrets file and encrypt a real signing key

This task runs **on redtruck**, as the user who holds an age key listed under `secrets/hosts/redtruck\.yaml$` in `.sops.yaml` (`waktu_redtruck` or `waktu_t495`). It produces no Nix changes — only a valid, decryptable `redtruck.yaml`.

**Files:**
- Modify: `secrets/hosts/redtruck.yaml` (via `sops` only)

**Interfaces:**
- Consumes: nothing
- Produces: a `devbox-signing-key` entry in `secrets/hosts/redtruck.yaml` holding an ed25519 private key in OpenSSH format; a public key string used by Task 3

- [ ] **Step 1: Confirm the file is currently broken**

```bash
nix run nixpkgs#sops -- -d secrets/hosts/redtruck.yaml >/dev/null
```

Expected: FAIL. Either a YAML parse error or a MAC mismatch. This is the proof that the `PLACEHOLDER` line took down decryption for *all three* secrets in the file, not just the new one.

- [ ] **Step 2: Revert the file to its last valid state**

```bash
git checkout 1cf8af0 -- secrets/hosts/redtruck.yaml
nix run nixpkgs#sops -- -d secrets/hosts/redtruck.yaml | grep -c 'devbox-'
```

Expected: PASS, prints `2` (`devbox-github-token`, `devbox-paseo-password`).

- [ ] **Step 3: Generate a fresh signing key**

```bash
umask 077
ssh-keygen -t ed25519 -C "devbox@redtruck" -f /tmp/devbox-signing -N "" -q
cat /tmp/devbox-signing.pub
```

Record the printed public key — Task 3 Step 1 pastes it into GitHub. No passphrase: nothing in the container can prompt for one.

- [ ] **Step 4: Encrypt the private key into the sops file**

`sops set --value-file` requires the file to hold valid **JSON**, not raw text —
a bare private key fails with `Value for --set is not valid JSON`. So JSON-encode
it first. Note also that the flag must come **before** the positional arguments;
`sops set <file> <index> --value-file <path>` fails with `Invalid set index
format`.

```bash
nix run nixpkgs#jq -- -Rs . < /tmp/devbox-signing > /tmp/devbox-signing.json
nix run nixpkgs#sops -- set --value-file \
  secrets/hosts/redtruck.yaml '["devbox-signing-key"]' /tmp/devbox-signing.json
```

Reading from a file rather than the command line keeps the key out of shell
history and `ps` output.

Verified end to end against a scratch sops file: round-trips byte-identical, the
sibling secret still decrypts, the value is stored `ENC[AES256_GCM,...]`, and the
decrypted key signs.

The interactive alternative is `sops secrets/hosts/redtruck.yaml`, which opens the
*decrypted* plaintext in `$EDITOR` and re-encrypts plus re-MACs on save. Safe, but
the key must be pasted as a YAML block scalar (`devbox-signing-key: |`) with every
line indented — a silent indentation mistake is why the non-interactive form is
preferred here.

- [ ] **Step 5: Verify the round-trip byte-for-byte**

```bash
nix run nixpkgs#sops -- -d --extract '["devbox-signing-key"]' \
  secrets/hosts/redtruck.yaml | diff - /tmp/devbox-signing && echo "ROUND TRIP OK"
```

Expected: `ROUND TRIP OK`, no diff output. If `diff` reports a trailing-newline difference, re-run Step 4 — a mangled key will fail at signing time with an unhelpful error.

- [ ] **Step 6: Confirm the value is encrypted at rest**

```bash
grep -q 'devbox-signing-key: ENC\[AES256_GCM' secrets/hosts/redtruck.yaml \
  && echo "ENCRYPTED OK"
grep -c 'PRIVATE KEY' secrets/hosts/redtruck.yaml
```

Expected: `ENCRYPTED OK`, and `0` occurrences of `PRIVATE KEY`. If either check fails, **stop** — do not commit.

- [ ] **Step 7: Delete the plaintext key and commit**

```bash
shred -u /tmp/devbox-signing /tmp/devbox-signing.json
git add secrets/hosts/redtruck.yaml
git commit -m "fix(devbox): encrypt real signing key, drop broken placeholder

The placeholder committed in 4075505 was unparseable YAML and outside
the sops MAC, so \`sops -d\` failed for the whole file - taking the
existing github-token and paseo-password secrets down with it."
```

Keep `/tmp/devbox-signing.pub` until Task 3 Step 1 is done.

---

### Task 2: Replace the ssh-agent machinery with a direct key file

**Files:**
- Modify: `modules/devbox/container.nix:113-138` (git settings + `ssh_config`), `:142-168` (the `ssh-agent-devbox` unit and `sessionVariables`), `:197-200` (paseo `SSH_AUTH_SOCK`)
- Modify: `modules/devbox/nixos.nix:78-91` (`signingKeyFile` option description)
- Modify: `hosts/redtruck/default.nix:17-50` (sops secret ownership + the block comment above it)

**Interfaces:**
- Consumes: `/run/secrets/devbox-signing-key` — the bind mount added by `4075505` in `modules/devbox/nixos.nix:153-156`, which stays exactly as it is
- Produces: signed commits from the `agent` user (uid 1500) inside the container; no systemd units, no sockets, no environment variables

- [ ] **Step 1: Fix the git settings and delete the `ssh_config`**

In `modules/devbox/container.nix`, replace lines 113-138 (from the `# Signed commits via SSH agent.` comment through the closing `'';` of the `xdg.configFile` block) with:

```nix
      # Signed commits. git shells out to `ssh-keygen -Y sign -f <keyfile>`,
      # which takes a key file and not an agent socket - so this is the whole
      # mechanism, there is nothing else to run. The key is the sops secret
      # bind-mounted read-only; see hosts/redtruck/default.nix for why it has
      # to be mode 0400 owned by this uid specifically.
      programs.git = {
        enable = true;
        settings = {
          user = {
            name = "BJSummerfield";
            email = "brianjsummerfield@gmail.com";
            signingkey = "/run/secrets/devbox-signing-key";
          };
          gpg.format = "ssh";
          commit.gpgSign = true;
          # Reads the token at use time so it never lands in a config file
          # or the nix store. The token bounds which repos are reachable;
          # a GitHub ruleset is what stops a push to a protected branch.
          credential."https://github.com".helper =
            "!f() { echo username=x-access-token; echo password=$(cat /run/secrets/devbox-github-token); }; f";
        };
      };
    };
  };
```

Three things changed from the committed version: `signingkey` is a plain string rather than a `pkgs.writeTextFile` derivation (Home Manager's `programs.git.settings` leaf type is `str | bool | int`, and the derivation is what makes redtruck fail to evaluate); it points at the private key rather than a public one; and the `xdg.configFile."ssh/ssh_config"` block is gone — that path is not one OpenSSH reads (it reads `~/.ssh/config`), and `IdentityAgent` is irrelevant to `ssh-keygen -Y sign` regardless.

- [ ] **Step 2: Delete the ssh-agent service and `sessionVariables`**

Still in `modules/devbox/container.nix`, delete lines 142-168 entirely — the `SSH agent for commit signing` banner, the `systemd.services.ssh-agent-devbox` block, and the `environment.sessionVariables.SSH_AUTH_SOCK` line. The result is that the `# paseo` banner follows directly after the closing `};` of the home-manager block.

Every one of these was broken and none is needed: `Type = "fork"` is not a valid systemd type (it is `forking`, and the invalid value is the *second* eval failure); the multi-line `ExecStart` used `&&` in a context where systemd runs no shell, so the unit's `ExecStart` was really just `mkdir -p /run/ssh-agent-devbox &&`; `ssh-agent -D` never exits so `ssh-add` was unreachable anyway; the agent ran as root so the socket would have been root-owned `0600` and unreadable to uid 1500; and `ssh-agent -k -c <sock>` misuses both flags, so `ExecStop` would always fail and, with `Restart = "on-failure"`, produce a restart loop.

- [ ] **Step 3: Delete the paseo `SSH_AUTH_SOCK` passthrough**

In the `services.paseo.environment` block, delete these three lines:

```nix
      # Duplicated from sessionVariables so pase's child processes (agents)
      # can find the SSH agent for commit signing.
      SSH_AUTH_SOCK = "/run/ssh-agent-devbox.sock";
```

`PASEO_WEB_UI_ENABLED = "true";` becomes the last entry in the block again.

- [ ] **Step 4: Correct the `signingKeyFile` option description**

In `modules/devbox/nixos.nix`, replace the description of `signingKeyFile` (lines 80-89) with:

```nix
      description = ''
        Path on the host to an unencrypted ed25519 SSH private key used to
        sign git commits inside the container. Typically the decrypted path
        from sops-nix.

        Ownership is load-bearing and differs from both other secrets here.
        git signs by running `ssh-keygen -Y sign` as the agent uid, and
        OpenSSH refuses a private key unless the file is owned by the
        calling uid and has no group or other permission bits set. So
        neither githubTokenFile's `mode = "0440"; group = "users";` nor
        paseoPasswordFile's root-only default works: the file must be mode
        0400 owned by uid 1500 itself, which sops-nix can only express via
        its numeric `uid` option. See hosts/redtruck/default.nix.

        No passphrase - nothing in the container can prompt for one.
      '';
```

The committed description claims the key is "loaded by the ssh-agent-devbox systemd service" and "never read by user processes", both of which stop being true in Step 1-2, and it points at the root-only mode that cannot work.

- [ ] **Step 5: Give the sops secret uid 1500**

In `hosts/redtruck/default.nix`, replace the `devbox-signing-key` secret (lines 44-49) with:

```nix
    # Read directly by `ssh-keygen -Y sign` running as agent, so unlike
    # paseo-password it cannot be root-only - and unlike github-token it
    # cannot use 0440/group=users either, because OpenSSH ignores any
    # private key with a group or other bit set. That leaves exactly one
    # shape: 0400 owned by uid 1500. `owner` takes a host username and no
    # host user has that uid, so this uses the numeric `uid`, which
    # sops-nix applies even when no such user exists.
    devbox-signing-key = {
      sopsFile = ../../secrets/hosts/redtruck.yaml;
      mode = "0400";
      uid = 1500;
    };
```

Leave `owner` and `group` unset — sops-nix asserts that `uid != 0` implies `owner == null`.

- [ ] **Step 6: Update the block comment above `sops.secrets`**

That comment (lines 17-36) still says "The two modes differ deliberately and point opposite ways" and describes only two secrets. Change the opening sentence and add the third entry so the table matches reality:

```nix
  # devbox container secrets. All three are bind-mounted read-only into the
  # container by modules/devbox/nixos.nix; none ever enters the container's
  # filesystem or the nix store.
  #
  # The three modes differ deliberately:
  #
  #   github-token   read by the *agent* (uid 1500, group users) at use
  #                  time, via the git credential helper and the gh
  #                  wrapper. sops-nix's default 0400 root is unreadable
  #                  to it, and `owner` can't help - it takes a host
  #                  username and no host user has uid 1500.
  #
  #   paseo-password read by PID 1 as root, via the paseo unit's
  #                  EnvironmentFile=, before the process drops to
  #                  User=agent. Root-only is sufficient and safer: it
  #                  keeps the daemon password out of reach of anything
  #                  running as agent, including a compromised agent.
  #
  #   signing-key    read by the agent too, but OpenSSH refuses a private
  #                  key that any group or other bit can reach, so the
  #                  0440/group trick is out. 0400 owned by uid 1500.
  #
  # Rotating any of them needs `systemctl restart container@devbox` - the
  # bind mount resolved to the old file when the container started.
```

- [ ] **Step 7: Verify redtruck evaluates**

```bash
nix eval --raw .#nixosConfigurations.redtruck.config.system.build.toplevel.drvPath
```

Expected: PASS, prints a `/nix/store/...drv` path. Before this task it aborted twice — first on the `writeTextFile` type mismatch, then on `Type = "fork"`.

- [ ] **Step 8: Verify the signing config reached the container's git**

```bash
nix eval --raw \
  .#nixosConfigurations.redtruck.config.containers.devbox.config.home-manager.users.agent.programs.git.settings.user.signingkey
```

Expected: `/run/secrets/devbox-signing-key`

- [ ] **Step 9: Verify the ssh-agent unit is gone**

```bash
nix eval .#nixosConfigurations.redtruck.config.containers.devbox.config.systemd.services \
  --apply 's: builtins.hasAttr "ssh-agent-devbox" s'
```

Expected: `false`

- [ ] **Step 10: Build the closure**

```bash
nix build .#nixosConfigurations.redtruck.config.system.build.toplevel --no-link
```

Run this on redtruck itself — it is the machine with the cache and the horsepower.

Expected outcome depends on whether Task 1 has landed, because sops-nix
validates the sops file at **build** time, not just at activation:

- **Task 1 not yet done:** FAIL with `sops-install-secrets: manifest is not
  valid: cannot parse yaml of '...redtruck.yaml': yaml: line 2: did not find
  expected key`. This is Task 1's placeholder, not a defect in this task —
  and note what it means: the placeholder makes redtruck *unbuildable*, not
  merely undeployable.
- **Task 1 done:** PASS.

To isolate this task without Task 1, temporarily `git checkout 1cf8af0 --
secrets/hosts/redtruck.yaml`, rebuild, and confirm the error changes to
`secret devbox-signing-key ... cannot be found` — the value is absent rather
than the file being broken, which is the expected pre-Task-1 state. Restore
the file and `git restore --staged secrets/hosts/redtruck.yaml` afterwards.

- [ ] **Step 11: Commit**

```bash
git add modules/devbox/container.nix modules/devbox/nixos.nix hosts/redtruck/default.nix
git commit -m "fix(devbox): sign commits from a key file, drop the ssh-agent

git signs via \`ssh-keygen -Y sign -f <keyfile>\`, which takes a file and
not a socket, so the agent bought nothing. It also did not work: the
signingkey was a derivation where home-manager wants a string (redtruck
would not evaluate), Type was \"fork\" rather than \"forking\", the
multi-line ExecStart chained with && in a context with no shell, and the
root-owned socket was unreadable to uid 1500 anyway.

The one real constraint is that OpenSSH ignores a private key with any
group or other bit set, so the secret is 0400 owned by uid 1500 - which
sops-nix can only express through its numeric uid option."
```

---

### Task 3: Deploy and verify signing end to end

This task runs **on redtruck**. Task 1 must already be committed, or the container will fail to start on the missing bind-mount source.

**Files:**
- None modified — this is deployment and verification

**Interfaces:**
- Consumes: the `devbox-signing-key` secret from Task 1, the Nix changes from Task 2
- Produces: a signed commit visible as "Verified" on GitHub

- [ ] **Step 1: Register the public key with GitHub as a signing key**

Go to GitHub → Settings → SSH and GPG keys → New SSH key. Paste the contents of `/tmp/devbox-signing.pub` from Task 1 Step 3. **Set "Key type" to `Signing Key`, not `Authentication Key`** — an authentication key produces no "Verified" badge, and this is the single most common way this setup silently half-works.

The devbox pushes over HTTPS with a PAT, so this key is used for nothing but signatures.

- [ ] **Step 2: Rebuild the host**

```bash
sudo nixos-rebuild switch --flake .#redtruck
```

Expected: PASS. Substitute your usual rebuild invocation if it differs.

- [ ] **Step 3: Verify the secret materialized with the right ownership**

```bash
sudo stat -c '%n %U:%G %a' /run/secrets/devbox-signing-key
```

Expected: `/run/secrets/devbox-signing-key 1500:root 400` (the uid prints numerically because no host user owns it — that is the intended outcome, not an error).

If the mode or uid is wrong, `ssh-keygen` will refuse the key in Step 6 with `Permissions ... are too open` or `bad ownership`.

- [ ] **Step 4: Restart the container**

```bash
sudo systemctl restart container@devbox
sudo systemctl status container@devbox --no-pager
```

Expected: `active (running)`. The restart is required even though the rebuild touched the container config — the bind mount resolved to the old file when the container started.

- [ ] **Step 5: Verify the key is visible and readable inside the container**

```bash
sudo nixos-container run devbox -- sudo -u agent stat -c '%U:%G %a' /run/secrets/devbox-signing-key
sudo nixos-container run devbox -- sudo -u agent head -c 40 /run/secrets/devbox-signing-key
```

Expected: `agent:root 400`, then `-----BEGIN OPENSSH PRIVATE KEY-----`. A permission denied here means Step 3's ownership did not survive the bind mount.

- [ ] **Step 6: Make a signed commit inside the container**

```bash
sudo nixos-container run devbox -- sudo -u agent -H bash -lc '
  cd "$(mktemp -d)" && git init -q . && echo hi > a.txt && git add a.txt &&
  git commit -q -m "signing smoke test" &&
  git cat-file commit HEAD | head -5
'
```

Expected: the commit succeeds and `git cat-file` output contains a `gpgsig -----BEGIN SSH SIGNATURE-----` header. With `commit.gpgSign = true`, a signing failure aborts the commit — so a commit that completes at all is the signal.

Note that `git log --show-signature` will report `gpg.ssh.allowedSignersFile needs to be configured` — that is only about *local verification* and says nothing about whether the signature was written. GitHub does the verification that matters here.

- [ ] **Step 7: Confirm the "Verified" badge on GitHub**

Push a real commit from the devbox and check it on github.com. Expected: a green **Verified** badge.

If it instead shows **Unverified**: the signature exists but GitHub does not associate the key with the account. Re-check that Step 1 registered it as a *Signing Key*, and that `user.email` in the container (`brianjsummerfield@gmail.com`) is a verified email on the GitHub account.

- [ ] **Step 8: Clean up and update the PR**

```bash
rm -f /tmp/devbox-signing.pub
git push origin research/pat-commit-signing
```

Then rewrite the PR #93 description: the manual steps it currently lists reference an `sops --set` syntax that predates the installed sops, a public key that is no longer in use, and `ssh-add -l` as the verification step for an ssh-agent that no longer exists.

---

## Out of scope

One finding from the review sits outside this branch and should get its own change: `modules/system/nixos.nix:58` bumps `system.stateVersion` from `24.11` to `26.05` in the base module shared by every NixOS host. `stateVersion` is meant to stay pinned at the value a machine was installed with; moving it changes stateful service defaults underneath already-provisioned hosts. That commit is already on `main`.
