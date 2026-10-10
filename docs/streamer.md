# Setting up the streamer

`streamer` is a Raspberry Pi 4B that plays music to the desk DAC without the
desk computer being on. Phones and laptops anywhere in the house cast to it.

```
Jellyfin ──HTTP(S)──▶ Pi 4B ──USB──▶ USB→S/PDIF converter ──optical──▶ FiiO K11 R2R
                        ▲
   Symfonium (UPnP) ────┤
   Mac (AirPlay) ───────┘
```

The Pi runs two renderers, both advertised as **Desk**:

- `gmediarender`: a UPnP renderer. Symfonium casts to it. The Pi fetches the
  file from Jellyfin itself, so the phone only sends the controls.
- `shairport-sync`: an AirPlay target for the Mac. AirPlay is CD quality and
  re-times the stream slightly, so treat it as the convenience path.

Both write straight to the converter's ALSA `hw:` device with no software
mixing, so a 16/44.1 file reaches the DAC unchanged. A udev rule names the
first USB sound card `dac`, so any USB converter (Douk U2, Schiit Eitr 2, …)
works without a config change.

The module is `modules/streamer/nixos.nix`; the host is `hosts/streamer/`.

## Hardware

- Raspberry Pi 4B with the official 5.1 V / 3 A USB-C supply. A weak supply
  drops the USB bus, which is heard as dropouts.
- A USB SSD in a USB 3 enclosure, or a microSD card. The same image works on
  both.
- A USB→S/PDIF converter on one of the black USB 2 ports.
- An optical (TOSLINK) cable to the K11's optical input. Optical keeps the Pi
  electrically isolated from the DAC, so there's no ground-loop hum. The K11's
  optical input stops at 96 kHz (see [Playback settings](#playback-settings)).
- Wired Ethernet. The host config expects the NIC to be `end0`.
- Any normal Pi 4 case. No fan is needed: audio playback keeps the Pi near idle.

## 1. Let redtruck build ARM

The image is an `aarch64-linux` build. redtruck (x86) builds it through QEMU
emulation, enabled by `boot.binfmt.emulatedSystems` in
`hosts/redtruck/default.nix`. Rebuild redtruck once if it isn't already
running a generation with that line:

```fish
sudo nixos-rebuild switch --flake .#redtruck
```

Nearly everything comes from cache.nixos.org. The only real compile is
sops-nix's `sops-install-secrets`. The private cache isn't needed.

## 2. Register the host key with sops

Do this before building the image. The image carries waktu's
`hashedPasswordFile`, and if the Pi can't decrypt it the account has no
password. Key-based SSH still works then, but `sudo` doesn't (wheel needs a
password), and that includes `sudo tailscale up`.

Follow `New_Host.md` steps 1–4 with `host = streamer`:

1. Generate the host key into `/tmp/streamer-install/etc/ssh`.
2. Derive its age key with `ssh-to-age`.
3. Add `&host_streamer` to `.sops.yaml` and list it under the
   `secrets/users/waktu.yaml` rule. That's the only secret the Pi needs.
4. Run `sops updatekeys secrets/users/waktu.yaml`.

Then **commit and push**. The Pi's nightly auto-upgrade pulls the `verified`
branch from GitHub, so it has to see the same `.sops.yaml`.

## 3. Build the image

```fish
nix build .#nixosConfigurations.streamer.config.system.build.sdImage
ls result/sd-image/
```

The image is uncompressed (`sdImage.compressImage = false`), so it can be
written directly.

## 4. Flash it and add the host key

Find the SSD's device with `lsblk`. Check twice: `dd` overwrites whatever
it's pointed at.

```fish
set -l disk /dev/sdX
sudo dd if=(echo result/sd-image/*.img) of=$disk bs=4M status=progress conv=fsync
sudo partprobe $disk
sudo mount /dev/disk/by-label/NIXOS_SD /mnt
sudo install -d -m 755 /mnt/etc/ssh
sudo install -m 600 /tmp/streamer-install/etc/ssh/ssh_host_ed25519_key /mnt/etc/ssh/
sudo install -m 644 /tmp/streamer-install/etc/ssh/ssh_host_ed25519_key.pub /mnt/etc/ssh/
sudo umount /mnt
```

sshd only generates a host key when none exists, so the Pi keeps this one.
That's the key `.sops.yaml` knows about.

## 5. First boot

1. Plug in the SSD, Ethernet and the converter, then power on. On first boot
   the root partition grows to fill the disk.
2. Find the Pi's address on the router, then:

   ```fish
   ssh-keygen -R streamer
   ssh waktu@<pi-ip>
   ```

3. On the Pi:

   ```bash
   sudo ls /run/secrets-for-users/   # waktu/password_hash should be listed
   sudo tailscale up
   ```

If `/run/secrets-for-users/` is empty, check
`journalctl -u sops-nix-install-secrets` and compare the key's fingerprint
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) with `.sops.yaml`.

From then on, the Pi upgrades itself nightly from the `verified` branch. It
evaluates and builds on the Pi itself. Evaluation needs about 0.8 GB of RAM,
which fits even on a 2 GB board.

## 6. Check the audio

```bash
aplay -l                                     # the converter shows up as card "dac"
systemctl status gmediarender shairport-sync
```

Cast a 16/44.1 album from Symfonium to **Desk**, then while it plays:

```bash
cat /proc/asound/dac/pcm0p/sub0/hw_params    # rate: 44100, matching the file
```

The K11's display should show the same rate. After an hour of playback, check
the temperature with `cat /sys/class/thermal/thermal_zone0/temp`. 52000 means
52 °C, and anything under about 70 °C is fine.

## Playback settings

- **Symfonium:** in the Desk renderer's settings, turn volume control off, or
  leave it at 100. Any lower value is software attenuation, which changes the
  bits. Set volume on the preamp.
- **Converter volume:** some converters expose a hardware volume. Open
  `alsamixer -c dac` once and make sure it's at 100% / 0 dB.
- **Sample rate:** the K11's optical input tops out at 96 kHz, and nothing on
  the Pi resamples, so a 176.4/192 kHz file plays silence. If hi-res files
  turn up, cap the cast in Symfonium's transcoding settings to 96 kHz, or
  switch to the coax input (192 kHz). Coax ties the Pi's ground to the DAC,
  so listen for hum.
- **Mac:** pick **Desk** as the AirPlay output. Leave the Mac's volume at
  maximum; shairport-sync ignores it either way.

## Switching between Symfonium and AirPlay

Only one renderer can hold the converter at a time.

- **AirPlay after Symfonium:** this just works. shairport-sync restarts
  `gmediarender` before each AirPlay session, which releases the device even
  if a Symfonium queue was paused or had finished.
- **Symfonium after AirPlay:** deselect **Desk** on the Mac first. A paused
  AirPlay session keeps the device open, and the cast stays silent until it's
  released.

The K11's front-panel input selector picks between the Pi (optical) and the
KVM (USB). Nothing on the Pi can switch it.

## Troubleshooting

- **Won't boot from the SSD.** Pi 4s from late 2020 onward try SD then USB.
  Older boards need a bootloader update (Raspberry Pi Imager → Misc utility
  images → Bootloader → USB Boot). Some USB-SATA bridges don't work with
  U-Boot. If the enclosure won't boot, write the same image to a microSD card.
- **SSD disconnects under load.** Some USB-SATA bridges misbehave in UAS mode.
  Find the bridge's IDs with `lsusb` and add
  `boot.kernelParams = [ "usb-storage.quirks=<vid>:<pid>:u" ];` to the host.
  Bus-powered SSDs can also draw more than the Pi supplies; a powered
  enclosure fixes that.
- **No `dac` card.** Check `dmesg` after plugging in the converter. The udev
  rule matches any USB sound card. Once the converter is settled, pin it with
  `ATTRS{idVendor}`/`ATTRS{idProduct}` in `modules/streamer/nixos.nix`.
- **Cast plays nothing, or AirPlay is silent.** `journalctl -u gmediarender -u shairport-sync`.
  "Device or resource busy" means the other renderer still holds the device
  (see [Switching](#switching-between-symfonium-and-airplay)).
