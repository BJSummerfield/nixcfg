# Setting up a new host

This walks through provisioning a new NixOS machine with `nixos-anywhere`,
generating a fresh host SSH key, registering it in sops, re-encrypting
secrets so the new host can decrypt what it needs on first boot, and
rotating the user SSH key on the new host afterward.

**Assumptions:**

- A **builder** machine that has the flake checked out, `sops` and `nix`
  installed, and the user's age key at `~/.config/sops/age/keys.txt`.
- A **target** machine booted from a NixOS minimal installer USB with SSH
  reachable on the local network.
- The flake already contains a host module for the new machine (including
  a working `disko.nix`) and the host is added to `flake.nix` outputs.

The builder and target can be any two machines — the only requirements
are that the builder can push commits to the flake repo and reach the
target over SSH.

## 0. Pre-flight the flake config

Before running the install, confirm the target's host module will
actually let you back in afterward. Getting these wrong doesn't stop
the install from completing, but does lock you out until you get
physical access.

**Inbound SSH must be enabled in the target host's config.** With this
repo's abstractions, that's:

```nix
mine.system.openssh = {
  inbound = {
    enable = true;
    openOnExternalInterface = true;  # only if on a trusted LAN
  };
  outbound.enable = true;
};
```

`inbound.enable = true` runs sshd. Without it, `nixos-anywhere`'s
post-install verification fails and the host is unreachable except via
console/keyboard.

**A working `authorizedKeys` entry** for the user you'll log in as. The
`sshKeys` attrset in `users/waktu.nix` should include at least one key
whose *private half you currently hold* — typically the builder's user
key, or a 1Password-managed key. Password auth is disabled by the
inbound module, so key auth is the only way in.

**A LUKS passphrase you can type.** disko will prompt for it during
partitioning; if the config uses random encryption for swap only and
LUKS on root without a keyfile, this is an interactive prompt on the
builder's terminal.

## 1. Generate the host SSH key on the builder

The target needs an ed25519 SSH key before first boot so sops-nix can
derive an age identity and decrypt secrets immediately. Generate it on
the builder and ship it across with `nixos-anywhere --extra-files`.

The working directory lives in `/tmp` — these are real private keys and
must not be committed.

```fish
set -l host redtruck  # change per host
set -l workdir /tmp/$host-install

mkdir -p $workdir/etc/ssh
ssh-keygen -t ed25519 -N "" -C "root@$host" \
  -f $workdir/etc/ssh/ssh_host_ed25519_key
chmod 600 $workdir/etc/ssh/ssh_host_ed25519_key
chmod 644 $workdir/etc/ssh/ssh_host_ed25519_key.pub
```

Notes on the flags:

- `-t ed25519` — sops-nix requires ed25519; `ssh-to-age` doesn't work with RSA.
- `-N ""` — no passphrase. Host keys are read unattended on every boot.
- The `chmod`s matter: sops-nix and sshd refuse to use a private key with
  loose permissions.

Sanity-check:

```fish
ssh-keygen -lf $workdir/etc/ssh/ssh_host_ed25519_key.pub
# prints: 256 SHA256:... root@<host> (ED25519)
```

## 2. Derive the age public key

sops-nix uses the host's ed25519 key as an age identity. Convert the
public key to its age form:

```fish
nix shell nixpkgs#ssh-to-age -c sh -c \
  "ssh-to-age < $workdir/etc/ssh/ssh_host_ed25519_key.pub"
```

Copy the `age1...` string it prints.

## 3. Register the age key in `.sops.yaml`

**Reinstalling an existing host:** replace the value of the existing
anchor (e.g. `&host_redtruck`) with the new age key. The anchor name
stays the same so `creation_rules` don't need to change.

```yaml
- &host_redtruck age1newkeyhere...
```

**Adding a brand-new host:** add a new anchor and include it in every
`creation_rules` entry whose secrets the host should be able to decrypt.

## 4. Re-encrypt secrets

`sops updatekeys` rewrites the recipient list of each file in place
based on the rules in `.sops.yaml`. You must already hold one of the
user keys currently on each file (your `~/.config/sops/age/keys.txt`).

```fish
sops updatekeys ./secrets/**.yaml
```

Confirm `y` on each prompt where the recipients actually changed. Files
whose recipients already match the rules are no-ops.

**Commit `.sops.yaml` and the updated secret files before running the
install.** `nixos-anywhere` builds the flake at the current commit — if
the re-encrypted secrets aren't committed, the new host can't decrypt
them on first boot, and any user with `hashedPasswordFile` (via
`neededForUsers = true`) ends up with a locked account.

## 5. Boot the target from a NixOS installer USB

Flash a NixOS minimal ISO to a USB stick and boot the target. The live
installer logs in as the `nixos` user automatically.

Avoid running `nixos-anywhere` against a live (non-installer) system via
kexec — WiFi credentials don't survive the handoff, and if the target is
on WiFi the in-memory installer ends up unreachable. Booting the
installer USB directly is more reliable, and works over both wired and
wireless once networking is configured in the next step.

## 6. Bring up networking on the target

Wired: plug in ethernet, DHCP runs automatically.

WiFi:

```bash
sudo systemctl start wpa_supplicant
wpa_cli
# inside wpa_cli:
> add_network
0
> set_network 0 ssid "YourSSID"
> set_network 0 psk "YourPassword"
> enable_network 0
> quit
```

Or, if available in your installer:

```bash
sudo systemctl start NetworkManager
nmtui
```

Grab the IP once the interface is up:

```bash
ip -4 -brief addr
```

Note the address on the active interface (skip `lo`).

## 7. Set a password for the `nixos` user on the target

The installer's `nixos` user has no password by default. `nixos-anywhere`
needs to SSH in once to bootstrap and will prompt for this password.
It's throwaway — the disk gets wiped on the next step regardless.

```bash
sudo passwd nixos
```

## 8. Install with nixos-anywhere on the builder

```fish
nix run github:nix-community/nixos-anywhere -- \
  --flake .#$host \
  --extra-files $workdir \
  --target-host nixos@<installer-ip>
```

Use the LAN IP from step 6 — Tailscale hostnames won't work here because
Tailscale isn't running in the installer.

`--extra-files` copies the working directory into `/` on the target
before the first boot, so the host key lands at
`/etc/ssh/ssh_host_ed25519_key` with the correct ownership (`root:root`)
and mode (`600`). LUKS prompts for a passphrase interactively during the
disko partitioning step.

The command builds the system on the builder, copies it to the target,
partitions, installs the bootloader, and reboots. Expect 10–30 minutes
depending on closure size, network, and target CPU.

## 9. Verify the new host is healthy

Since the host key rotated (or is brand new), clear any stale
`known_hosts` entries on the builder before reconnecting:

```fish
ssh-keygen -R $host
ssh-keygen -R <host-ip>
```

Confirm the host is up and sops decrypted secrets. Since inbound sshd
uses `PermitRootLogin = "no"`, log in as your user:

```fish
ssh waktu@<host-ip>
```

Once in, on the target:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
sudo systemctl status sops-nix-install-secrets.service
sudo ls /run/secrets/ /run/secrets-for-users/
```

If `/run/secrets-for-users/` is empty, any user with `hashedPasswordFile`
will have a locked account. In that case, check the
`sops-nix-install-secrets` journal on the target for decryption errors
and recheck that the deployed host key matches `.sops.yaml`.

Working directory cleanup on the builder is optional — `/tmp` is a
tmpfs and clears on reboot — but if the builder stays up for long
stretches:

```fish
rm -rf $workdir
```

## 10. Rotate the user SSH key on the new host

The `sshKeys` attrset in `users/waktu.nix` holds the public halves of
waktu's *user* keys — one per host where waktu SSHes out from. On
reinstall, the private half at `~waktu/.ssh/id_ed25519` is gone, so the
existing public key entry for this host is stale and needs to be
regenerated.

On the target, as waktu:

```bash
ssh-keygen -t ed25519 -C "waktu@$host" -f ~/.ssh/id_ed25519
# passphrase is your call — no passphrase is simpler, one is safer
cat ~/.ssh/id_ed25519.pub
```

Copy the output.

On the builder, edit `users/waktu.nix` and replace the value for this
host:

```nix
sshKeys = {
  onepassword = "ssh-ed25519 AAAAC3...";
  t495 = "ssh-ed25519 AAAAC3...waktu@t495";
  redtruck = "ssh-ed25519 AAAAC3newkeyhere waktu@redtruck";  # updated
};
```

Commit and rebuild each host that grants access to waktu so their
`authorized_keys` files pick up the new pubkey:

```fish
# on each affected host, or from the builder targeting each
sudo nixos-rebuild switch --flake .#<hostname>
```

If waktu's git commit signing uses `signingkey = "/home/waktu/.ssh/id_ed25519.pub"`
(as in this repo's config), the signing identity rotates too. Update:

- GitHub SSH signing keys (Settings → SSH and GPG keys → New SSH key,
  type "Signing Key")
- Any `allowed_signers` files used to verify commit signatures locally

## 11. Rotate the user age key (dev machines only)

Skip this step if the new host isn't used for editing sops secrets —
i.e. it doesn't have (and shouldn't have) a `waktu_<host>` anchor in
`.sops.yaml`. Servers, appliances, and single-purpose hosts fall in
this category.

For a dev machine (anywhere you'll run `sops` to edit secrets in the
flake), the user needs their own age identity separate from the host
key. It lives at `~/.config/sops/age/keys.txt` and is what `sops` picks
up when the user (not the system) decrypts files.

On the target, as waktu:

```bash
mkdir -p ~/.config/sops/age
nix shell nixpkgs#age -c age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt
```

The output includes both the private key (kept in the file) and a
`# public key: age1...` comment line. Grab the public key:

```bash
grep 'public key' ~/.config/sops/age/keys.txt
```

On the builder, edit `.sops.yaml`:

**Reinstalling an existing dev host:** replace the value of the matching
anchor (e.g. `&waktu_redtruck`) with the new age key. No other changes
needed — the anchor is already referenced everywhere it should be.

```yaml
- &waktu_redtruck age1newuserkey...
```

**Adding a brand-new dev host:** add a new `&waktu_<host>` anchor, then
add it to every `creation_rules` entry the user should be able to
decrypt. In this repo's model, that's typically all of them, since the
user is a flake maintainer.

Then re-encrypt every secret so the new user key is on the recipient
list:

```fish
sops updatekeys ./secrets/**.yaml
```

Commit `.sops.yaml` and the updated secret files.
