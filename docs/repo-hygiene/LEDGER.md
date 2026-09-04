# LEDGER — the repo walk

**What this is.** A per-file survey of every `.nix` file in this repo, produced
by task TW, plus the four cross-file syntheses the per-file agents could not
produce. This is the single input that T5, T6, T7, T8, T13 and GATE 2 consume
instead of re-deriving. It is a *survey*, not a plan: it records what is there,
what fails `RUBRIC.md`, and where a fix would go. It does not fix anything.

**Commit described.** `500ff35`. Everything below is true at that revision; a
citation of the form `file:line` is only valid against that commit.

**Coverage.** 132 `.nix` files, walked in 11 batches by 11 independent agents,
none of which read another's files. Verified: `find . -name '*.nix' -not -path
'./.git/*' | wc -l` → 132, and the 11 shards' per-file sections sum to 132.

Verdict distribution across the 132:

| verdict | count | note |
|---|---|---|
| coherent | 100 | includes ~6 that a shard described as "coherent (table)" |
| table (B4) | 24 | 15 of them are `modules/helix/languages/*.nix` |
| **overloaded** | **4** | see §2 |
| out of scope | 4 | the four generated `hardware-configuration.nix` |

This is a healthy distribution per TW's acceptance criterion 5 — neither
"everything is fine" nor a line-count witch hunt.

**How to read it.**
- §2 is GATE 2's primary input: every *overloaded* verdict with its destination,
  plus the suspicions the walk **cleared** (a cleared suspicion is a result).
- §3 and §4 are the cross-file findings — they do not exist in any single shard.
- §5 is a faithful inventory, not a proposal. Read the caveat at its head.
- §6 is defects, not hygiene. Fix these regardless of what the plan decides.
- §7 is the raw 11 shards, lightly normalized (headings demoted, nothing else
  rewritten). Judgements, hedges and citations are the shards' own.

**Provenance rules honored here.** Nothing below is invented; everything traces
to a shard or to a spot-check explicitly labelled as such. Where two shards
disagree, the disagreement is surfaced rather than resolved (§4). Where a shard
hedged ("medium confidence", "could not judge"), the hedge is carried forward.
Where a spot-check contradicted a shard, the correction is inline and marked
**CORRECTION**.

---

## 1. Corrections found while synthesizing

Four shard/R4 claims were spot-checked against the repo and did not hold. They
are corrected here rather than dropped, because six downstream tasks navigate by
these citations.

1. **CORRECTION (major) — `modules/theme/home.nix` is NOT orphaned.**
   Shard 11 calls this "the single most valuable finding in this shard": that
   `theme/home.nix` is imported nowhere and every Linux host silently loses
   GTK/Qt/cursor theming. It is wrong. `modules/theme/nixos.nix:36-37` reads:
   ```
   home-manager.sharedModules = [
     ./home.nix
   ];
   ```
   inside its `config = mkIf cfg.enable` block. Shard 11's evidence was
   `grep -rn "theme/home"`, which cannot match a relative `./home.nix` written
   from inside `modules/theme/`. Shard 04 (the batch that actually owned
   `modules/theme/`) described the wiring correctly. Verified further:
   `hosts/redtruck/default.nix:124` and `hosts/t495/default.nix:33` both set
   `mine.system.theme.enable = true`, so both do get the theming.
   **Residual real fact, downgraded from bug to policy:** `hosts/elitebook/
   default.nix` sets no `theme` block at all, so elitebook gets no
   fonts/dconf/Qt/GTK theming. That is a host choosing not to enable a module,
   which is what the option is for — worth asking the user about, not a defect.
   Shard 11's own "checked and cleared" note on `pi-coding-agent/home.nix`
   (imported directly by `modules/devbox/container.nix:146`, deliberately not in
   the aggregator) stands; only the theme claim is retracted.

2. **CORRECTION — `modules/nixos.nix` has three ordering violations, not two.**
   Shard 11 found two. A third: `./jellyfin-server/nixos.nix` (line 14) sits
   *before* `./jellybox/nixos.nix` (line 15), and "jellybox" < "jellyfin"
   alphabetically. Full list in §6.

3. **CORRECTION (confirming shard 10 against R4) — redtruck is 6/6, not 6/7.**
   `tasks/R4.md` G2#3 says `hosts/redtruck/default.nix` repeats the identical
   sopsFile path on "6/7" secrets. Shard 10 corrected this to 6/6. Verified:
   `grep -c 'sopsFile = ' hosts/redtruck/default.nix` → 6, all six
   `../../secrets/hosts/redtruck.yaml`. There is no seventh entry. Shard 10 is
   right, R4 is off by one.

4. **CORRECTION — R4's vikunja citation is off by two lines.**
   R4 G1#1 cites `modules/vikunja-server/nixos.nix:144` for a hand-built
   `${pkg}/bin/` path. The actual site is **`:142`**, and it is
   `${config.services.postgresql.package}/bin/pg_dump` — a `config.services.*`
   package reference, not a `pkgs.*` one, so the replacement is
   `lib.getExe' config.services.postgresql.package "pg_dump"`, not `lib.getExe
   pkgs.<x>`. Shard 07 folded this site into R4's finding without re-citing it
   and so inherited the wrong line number.

---

## 2. Responsibility verdicts (GATE 2's primary input)

### 2a. Overloaded — 4 files, each with its destination

Rubric B's test is a responsibility audit, not a line count. Only four files
failed it. Every one names where the foreign responsibility goes.

**1. `modules/devbox/container.nix` — two foreign responsibilities.** (shard 03)
- Agent-tooling definitions: `piWrapped` (`:33-40`), `ghWrapped` (`:59-62`),
  `claudeSettings` (`:76-82`), `agentPkgs` (`:42-55`).
  → **`modules/devbox/agents.nix`**, which already exists for exactly this job
  ("Agent launchers for the devbox container"). container.nix currently
  duplicates that file's purpose instead of using it.
- The inline `home-manager.users.agent = {...}` block (`:138-231`, ~94 lines).
  → **a new `modules/devbox/home.nix`**, matching this repo's own split
  convention used by the very modules this block imports
  (`../direnv/home.nix`, `../pi-coding-agent/home.nix`, at `:145-146`).
- Everything else (users / nix settings / paseo / tailscale / tmpfiles) is
  coherent as one container's system policy and stays.
- Shard confidence: high on the split; medium on which of three EROFS comment
  clusters is canonical.

**2. `modules/users/nixos.nix` — two jobs on different change schedules.** (shard 08)
- "Declare user accounts" (the `mine.users` submodule type, `users.users`
  mapping, the two assertions) and "wire home-manager" are two jobs: a new
  account field and a new HM wiring need change for different reasons.
- The home-manager wiring block (`:118-134`) plus the unfree bridge
  (`:110-116`, duplicated verbatim in `modules/users/darwin.nix`)
  → **a new `modules/users/home-manager.nix`**, imported alongside, leaving
  `nixos.nix` as pure account declaration.
- Shard confidence: high on the verdict; **medium on the exact split point** —
  it did not verify whether the bridge belongs in the new file or stays shared,
  and did not verify the proposed filename against repo convention. Carry that
  hedge forward.

**3. `hosts/elitebook/default.nix` — B8: a host wrote *how*, not *that*.** (shard 10)
- `environment.etc."wireplumber/...".text` at `:19-24` is raw INI implementing
  a default-volume policy inline in a host file.
- → **`modules/pipewire/nixos.nix` as a new suboption** (e.g.
  `mine.system.pipewire.defaultVolume`), mirroring the `sample-switch`
  suboption already in that file at `modules/pipewire/nixos.nix:12-13`, which
  already generates a wireplumber stanza from an option instead of inlined text.
- Everything else in the file (imports, systemPackages table, `mine.system.*`
  policy, per-user block) is host policy and stays.

**4. `hosts/redtruck/default.nix` — module documentation and module-generatable
config living in a host.** (shard 10; this is FINDINGS.md's T8 target, confirmed
with line numbers)
- The 34-line comment block at `:16-49` (container secret-mount contract,
  per-secret-type mode/owner rationale, rotation instructions) is module
  documentation wearing a host file.
  → **`modules/devbox/nixos.nix`**, which already carries the doc header for
  `mine.system.devboxes` (`:1-17`) and the per-field `description` strings on
  `githubTokenFile` etc. (~`:60+`). The mode/owner/uid rationale belongs next to
  those descriptions, not restated at every host that uses devboxes.
- The six near-identical `sops.secrets.*` declarations at `:50-73`
  (github-token / paseo-password / signing-key × 2 containers)
  → **generatable by `modules/devbox/nixos.nix` from the `devboxes` attrset**,
  which already knows each instance needs exactly these three secrets with
  exactly these mode/owner rules. A host should name the instance and one
  sopsFile, not restate the contract six times.
- `:99-103` (devboxes rationale) is a defensible A-rubric keep *if it stays
  host-side*, but is really explaining the pattern, which again belongs with the
  module's option descriptions.
- The file also fails B5 on its own terms: it is a desktop workstation policy
  **and** a coding-agent container-host policy.

### 2b. Cleared suspicions — files FINDINGS.md flagged that the walk exonerated

Each of these was examined deliberately and came back not-overloaded. Recording
the clearance is the point; without it a later task re-opens them.

| file | suspicion | walk's verdict and evidence |
|---|---|---|
| `modules/firefox/home.nix` | 206 lines, presumed overloaded | **table (B4)** — every entry is the same kind of thing (a locked pref / forced value) serving one job, privacy-hardened Firefox. Nothing in it belongs to another file. Shard 06 explicitly notes it resisted calling this overloaded from length alone. |
| `modules/filesystems/nas.nix` | long, presumed overloaded | **coherent, and explicitly not a table** — mount + gate access to NAS shares is one job; the group/mount/assertion/symlink logic all exists *because of* the access-control facet. Shard 06: "the FINDINGS.md flag looks driven by line count, which rubric B4 explicitly rejects as the test." |
| `modules/dns-server/nixos.nix` (250 l.) | large service module, B6 | **coherent**; B6 moot — `options.mine.system.dns-server` and `config = lib.mkIf cfg.enable {...}` are already two separate top-level blocks. Nothing interleaved. |
| `modules/immich-server/nixos.nix` (223 l.) | same | **coherent**; options at `:23-25`, config at `:27-222`, already cleanly separated. Enabling sibling `mine.system.nas.shares` from here is the repo's established cross-module dependency-activation pattern, not a foreign responsibility. |
| `modules/stalwart-server/nixos.nix` (295 l.) | same | **coherent**; options `:34-45`, config `:47-294`, already separated. The caddy/firewall/NAT triad is one "be reachable under either topology" job; it declares one route into the caddy module (same pattern as `modules/photoform/nixos.nix:62`), it does not own caddy's routing. |
| `tests/devboxes.nix` (279 l.), `tests/photoform.nix` (258 l.) | long | **table (B4)** — a list of named boolean assertions. "Exactly the 'thirty language definitions' case rubric B4 describes." Shard 11: FINDINGS.md's flag was worth checking, resolves to fine-as-is. |
| `checks/default.nix` | 5 facets, presumed overloaded | **table** — every entry is "a derivation that fails CI if something is broken", even though the somethings differ (eval / lint / package / caddyfile). No further split recommended. |
| `packages/default.nix` | naming (`packages/` holds only wiring) | **not a defect** — this is B7 working as intended; derivations live in `modules/*/package.nix`, and `packages/default.nix` is correctly named for what it produces (the flake's `packages` output). No rename. |
| `modules/theme/darwin.nix` | 1 line, presumed vestigial | **coherent, thin by design** — darwin has no NixOS-only sinks this module writes to. Confirmed by `hosts/mac/default.nix:31` setting `theme.fontSizes.terminal` without ever setting `theme.enable`, and that value still reaching `alacritty/home.nix` because `shared.nix`'s `themeConstants` push is unconditional. Shard confidence **medium** (verified by reading + grep, not by building the darwin host). |
| `modules/system/nixos.nix` | presumed to hold non-system knobs | **coherent** — every option (`hostName`, `externalInterface`, `renderGroupGid`, `wheelNeedsPassword`, `autoUpgrade`, `privateCache`, `boot.*`) is genuinely machine-level. Does not corroborate FINDINGS.md's `mine.system.*` complaint. |
| `modules/unfree/{darwin,home,nixos,options}.nix` | 30 lines over 4 files, over-decomposed? | **coherent** — follows the repo's per-platform convention. Only real finding is a 3-line predicate lambda duplicated between darwin.nix and nixos.nix; 6 total lines, too small to action (see §3b). |
| `modules/niri/home.nix` | `mine.user._1password.silentStart.enable = true` at `:29` looks foreign | **coherent, not promoted** — a single-line cross-module default where niri is the trigger, not the payload. Shard confidence **medium**; it is a judgment call about whether that line belongs here or in `_1password/home.nix`. |
| `flake.nix` | post-T9 bloat | **coherent** — T9's 247→116-line extraction landed, no leftovers. |
| `modules/local-llm/nixos.nix` | 94 comment lines / 35% | **coherent**, B6 respected (options block separate and small). The comment ratio is a smell that resolved to mostly-keeps; see §5. |

---

## 3. Cross-file idiom summary (G1 / G2)

These are the findings that only exist in comparison. Each is deduplicated
across all 11 shards, cited per G4 (old site, replacement, where the replacement
already lives), and sorted into **actionable** (clears rubric G3 — shorter,
harder to get wrong, or removes a hand-rolled thing upstream now owns) and
**recorded-and-dropped** (fails G3). Being explicit about what was deliberately
*not* actioned is as important as the actionable list — §3b exists so a later
reader does not re-discover and re-propose these.

R4's four settled items (`types.string`, `types.loaOf`, file-scope `with lib;`,
hand-rolled boolean `enable = mkOption`) came back **empty repo-wide** and are
not re-flagged. Confirmed against every shard: no shard reported an instance.

### 3a. Actionable

**A1. Hand-built `${pkg}/bin/x` vs `lib.getExe` / `lib.getExe'`. (G1, R4 item 1)**

The single largest idiom cluster. Consolidated from R4 plus shards 01, 02, 03,
07, 09, and re-derived by direct grep at commit `500ff35`
(`grep -rn '\${[a-zA-Z0-9_.-]*}/bin/' --include=*.nix modules hosts users tests checks`)
to catch sites the shards' narrower patterns missed. **Twelve live sites**
(a thirteenth, `modules/jellybox/nixos.nix:30`, is inside a commented-out
example and is excluded):

| site | expression | replacement | notes |
|---|---|---|---|
| `modules/local-llm/nixos.nix:214` | `${pkgs.podman}/bin/podman` | `lib.getExe' pkgs.podman "podman"` | sharpest case in the repo: the reference spelling is in the **same directory**, `vllm-service.nix:17`, newer file (2026-09-01) |
| `modules/swaybg/home.nix:31` | `${pkgs.swaybg}/bin/swaybg` | `lib.getExe pkgs.swaybg` | R4-cited |
| `modules/swayidle/home.nix:11` | `${pkgs.brightnessctl}/bin/brightnessctl` | `lib.getExe pkgs.brightnessctl` | R4-cited |
| `modules/swayidle/home.nix:12` | `${pkgs.niri}/bin/niri` | `lib.getExe pkgs.niri` | R4-cited |
| `modules/swayidle/home.nix:13` | `${pkgs.swaylock-effects}/bin/swaylock` | `lib.getExe pkgs.swaylock-effects` | **mainProgram caveat**, see below |
| `modules/swayidle/home.nix:45` | `${pkgs.systemd}/bin/systemctl` | `lib.getExe' pkgs.systemd "systemctl"` | R4-cited |
| `modules/hyprlax/home.nix:39` | `${pkgs.hyprlax}/bin/hyprlax` | `lib.getExe pkgs.hyprlax` | shard 09, **not in R4's list** |
| `modules/helix/languages/markdown.nix:18` | `${pkgs.mpls}/bin/mpls` | `lib.getExe pkgs.mpls` | shard 01, **not in R4's list**; **mainProgram caveat** |
| `modules/devbox/container.nix:53` | `${piWrapped}/bin/pi` | `lib.getExe piWrapped` | **blocked**, see below |
| `modules/backups/nixos.nix:106` | `${pkgs.nixos-container}/bin/nixos-container` | `lib.getExe' pkgs.nixos-container "nixos-container"` | shard 07 folded into R4 without citing; **cited here** |
| `modules/backups/nixos.nix:109` | same | same | |
| `modules/vikunja-server/nixos.nix:142` | `${config.services.postgresql.package}/bin/pg_dump` | `lib.getExe' config.services.postgresql.package "pg_dump"` | R4 cites `:144`; **actual is `:142`** (see §1.4). Not a `pkgs.*` reference. |

Reference / replacement site (where the current spelling already lives):
`modules/local-llm/vllm-service.nix:17,91,96,100,101` (newest, 2026-09-01),
plus `modules/devbox/agents.nix:18,29`, `modules/devbox/container.nix:45`,
`modules/photoform/nixos.nix:137`, `modules/jellybox/nixos.nix:9,11`,
`modules/alacritty/linux.nix:11`, `modules/_1password/home.nix:40` — 15+ sites.

**The three `mainProgram` caveats. Do not convert these blind:**
- **`piWrapped` (`container.nix:53`) — blocked, verified.** Shard 03 checked the
  derivation: `piWrapped` is a `symlinkJoin` named `"pi-wrapped"` (`:33-34`) with
  **no `meta.mainProgram`**, so `lib.getExe piWrapped` resolves today to
  `bin/pi-wrapped`, which does not exist. Converging requires first adding
  `meta.mainProgram = "pi";` to the derivation. In-repo reference for that
  addition: `modules/photoform/package.nix:38`, `modules/encode_queue/package.nix:18`.
- **`swaylock-effects` (`swayidle/home.nix:13`) — unverified.** Binary name
  (`swaylock`) differs from the package attr (`swaylock-effects`). Only
  convertible if `pkgs.swaylock-effects.meta.mainProgram == "swaylock"`. Shard 09
  flagged this explicitly as **not checked**; R4 flags the same caveat for this
  file. Verify before applying. Not laundered into certainty here.
- **`mpls` (`markdown.nix:18`) — unverified.** Shard 01 assumed a single
  `bin/mpls` output from the pname, and said so: "checked only by grep of local
  module files, not by inspecting the mpls derivation itself in nixpkgs — treat
  as should-verify-before-applying." Carried forward as such.

Out of scope, checked and excluded: `modules/polkit_kde/home.nix:19` uses
`/libexec/`, not `/bin/`, so `getExe` does not apply (shard 09).
`modules/battery-notifications/home.nix` builds a `PATH=` string, not an exec
call — PATH inclusion is not an invocation (shard 09).

Clears G3: shorter, and removes a hand-rolled store-path join that `lib` owns.

**A2. `sops.secrets.<name>` dotted-path vs nested-attrset for siblings. (G1, R4 item 2)**
- `hosts/redtruck/default.nix:56` and `:67` use the one-line dotted form
  (`devbox-paseo-password.sopsFile = ...;` / `workbox-paseo-password.sopsFile = ...;`)
  while their siblings at `:51-54`, `:57-61`, `:62-66`, `:68-72` use the nested
  attrset form, inside the same `sops.secrets` block, for the same secret family.
  Verified at `500ff35` (shard 10 confirms R4's citation with line numbers).
- Additional evidence from shard 06: `modules/photoform/nixos.nix:42-47` uses the
  dotted form uniformly across all four entries. This is same-file-uniform, so it
  is not an internal inconsistency — it is one more site on the older shape.
- Replacement: the nested-attrset form (the majority shape). Overlaps T8 / rubric
  F2; do not duplicate the finding there.

**A3. `sops.defaultSopsFile` is unset repo-wide. (G2, R4 item 3)**

Verified at `500ff35`: `grep -rn 'defaultSopsFile' --include=*.nix .` → **0 hits**.
Per-host repetition counts, from shard 10's grep, independently re-verified here:

| host | repeated identical path | count | the exception |
|---|---|---|---|
| `hosts/redtruck/default.nix` | `../../secrets/hosts/redtruck.yaml` at `:52,:56,:58,:63,:67,:69` | **6/6** | none — **R4's "6/7" is wrong**, see §1.3 |
| `hosts/vps/default.nix` | `../../secrets/hosts/vps.yaml` at `:42,:50,:90` | **3/4** | `:46` is `restic-b2.yaml`, genuinely elsewhere |
| `hosts/paynefield/default.nix` | `../../secrets/hosts/paynefield.yaml` at `:17,:25` | **2/3** | `:21` is `restic-b2.yaml` |
| elitebook / mac / t495 | — | n/a | declare no `sops.secrets` at all |

Replacement verified in pinned sops-nix source
(`.../s154mmk8ahvc71gq8xfkbzlk240yvniv-source/modules/sops/default.nix:203`,
used as the per-secret default at `:50`): set `sops.defaultSopsFile` once per
host, drop the repeated per-secret line, keep an explicit `sopsFile` override
only where a secret genuinely lives elsewhere. Shorter and typo-proof — clears G3.
Note the interaction: if §2a item 4 lands (devbox generating its own secrets),
redtruck's 6 collapse anyway.

**A4. disko device addressing — `/dev/nvme0n1` vs `/dev/disk/by-id/`. (G1, shard 10)**

Four `disko.nix` files, compared by mtime with the newest as reference per G1:

| file | date | device addressing |
|---|---|---|
| `hosts/redtruck/disko.nix` **(reference)** | 2026-07-10 | stable `/dev/disk/by-id/...` at `:10,:59,:75,:91,:107` |
| `hosts/t495/disko.nix` | 2026-05-06 | unstable `/dev/nvme0n1` at `:10` |
| `hosts/elitebook/disko.nix` | 2026-05-06 | unstable `/dev/nvme0n1` at `:11` |
| `hosts/vps/disko.nix` | 2026-04-29 | **excluded** — legitimately different topology (cloud VM, BIOS/GRUB, no removable disks) |

by-id paths survive device renumbering across kernel/driver changes and are not
longer or harder to write. Clears G3. Converge elitebook and t495 onto redtruck.

**A5. Five-way hand-copied TS-ecosystem recipe in `modules/helix/languages/`. (G1, shard 01)**

`javascript.nix:18-26`, `json.nix:17-25`, `jsx.nix:16-24`, `tsx.nix:17-25`,
`typescript.nix:34-42` repeat byte-for-byte the same `language-server` block
(biome lsp-proxy + `typescript-language-server.config.tsserver.path`) and the
same `extraPackages` list (4/5 identical; typescript.nix adds a conditional
prettier). `json.nix`, `jsx.nix`, `tsx.nix`, `typescript.nix` additionally
repeat an identical biome-formatter shape differing only in the
`--stdin-file-path file.<ext>` extension.

Replacement: a shared `let`-bound helper (e.g. `mkTsBiomeLanguage { name, ext,
extraServers ? [] }`) in `languages/default.nix` or a `lib.nix` sibling.
Clears G3 on both limbs: shorter (~8 duplicated lines × 5) **and** harder to get
wrong — the drift it prevents is already visible, since `typescript.nix`'s
formatter logic grew an `if cfg.formatter == "biome"` branch that the other four
copies never received. Lower-priority second instance of the same shape:
`css.nix:40-42,72` and `html.nix:25-27,52` duplicate the tailwind LSP pair.

Note this is a *within-directory* G1, so there is no older/newer reference —
the finding is "one recipe instead of five hand-kept copies," not "converge on
the newest."

**A6. Off-tailnet reachability — three spellings across four sibling
`*-server` container modules. (G1, shard 07) — actionable but deferred.**

| module | created | spelling |
|---|---|---|
| `modules/jellyfin-server/nixos.nix:55-62,152` | 2026-03-03 (oldest) | LAN firewall + NAT forward + container `allowedTCPPorts` all **unconditional** — no way to run tailnet-only without editing the module |
| `modules/teamspeak-server/nixos.nix:16-17,40-43,51-62,102-106` | 2026-03-06 | reachability is a first-class choice: two `mkEnableOption`s, `tailscaleAccess` and `publicAccess`, each independently gating dirs / bind-mounts / forwardPorts / firewall |
| `modules/terraria-server/nixos.nix` (`:83` `openFirewall = false`) | 2026-05-02 | no public-access option at all — tailnet-only baked in, reachability exclusively via `trustedInterfaces = [ "tailscale0" ]` |
| `modules/vikunja-server/nixos.nix` (no `allowedTCPPorts`) | 2026-05-27 (newest) | same as terraria |

Reading newest-as-reference, the trend is tailnet-only-by-default with no public
toggle. That makes teamspeak's explicit pair the most *deliberate* spelling and
jellyfin the outlier that never got an opt-out.

**Shard 07 recorded this and explicitly declined to chase it**, and that call is
preserved here: whether jellyfin genuinely needs LAN access is a product
decision about the house network, not a spelling fix. The *mechanical* half —
"a host currently cannot disable jellyfin's LAN/NAT exposure without editing the
module" — is real and is repeated in §6 as a live limitation. Do not converge
these three without asking the user which behaviour is wanted.

### 3b. Recorded and dropped (fails G3 — do not re-propose)

Fifteen patterns were found, evaluated, and deliberately not actioned. Each
entry states *why* it fails the bar, because "more modern" and "less duplicated"
are not by themselves reasons to change working code.

1. **`mkEnableOption` declaration-style split.** (shard 09) ~15 files destructure
   `inherit (lib) mkEnableOption mkIf; cfg = config.mine...;` in a `let`
   (battery-notifications, direnv, gamescope, hyprlax, encode_queue, makemkv,
   mako, nvidia, pipewire, steambox/home, steam, swaybg, swayidle, swaylock,
   teamspeak-client); ~8 call `lib.mkEnableOption` / `lib.mkIf` inline with no
   `let`/`cfg` (avahi, docker, gh, git, keybase/darwin, keybase/home,
   obs-studio; printing is a hybrid — `let cfg` but inline `lib.mkIf`).
   **Fails G3: both spellings are equally short and equally hard to get wrong.**
   Neither is "the newest" in any meaningful sense. Two spellings of one idea is
   exactly what G1 is about, and it still does not clear the bar for changing
   working code. This is the single most tempting item in the repo to
   mass-rewrite; it is the clearest example of what G3 exists to prevent.
2. **Theme-constants consumption style.** (shard 09) `inherit (themeConstants)
   colors;` (lazygit, mako) vs directly qualifying `themeConstants.colors.*`
   (swaylock). **Fails G3: cosmetic, zero functional difference.**
3. **The duplicated systemd hardening block — 7 verbatim copies.** (shard 07)
   `jellyfin-server/nixos.nix:163-182`, `teamspeak-server/nixos.nix:111-127`,
   `vikunja-server/nixos.nix:176-188`, plus `dns-server`, `photoform`,
   `stalwart-server`, `immich-server` all hand-roll the identical
   `ProtectHome`/`PrivateTmp`/`ProtectControlGroups`/`ProtectKernelTunables`/
   `NoNewPrivileges`/`RestrictAddressFamilies` set. **Fails G4, not just G3:
   they are identical, so there is no drift, and there is no existing
   replacement site in the repo to cite.** A `mkContainerHardening` helper would
   remove 7× duplication and is worth considering — as a **T13 candidate**, not
   as an idiom finding. Recorded so T13 does not have to re-find it.
4. **`modules/unfree/{darwin,nixos}.nix` duplicated predicate lambda.**
   (shard 09) 3 lines each, identical. **Fails G3 on size: 6 total duplicated
   lines does not justify an extraction.**
5. **`modules/users/{darwin,nixos}.nix` duplicated unfree bridge.** (shard 08)
   Same family as #4; the bridge logic and its comment (`nixos.nix:110-116` /
   `darwin.nix:13-15`) are near-verbatim. Recorded; note it *does* move if §2a
   item 2's split lands, so sequence it after that rather than as its own task.
6. **`modules/fuzzel/home.nix:58` hand-built INI vs `programs.fuzzel.settings`.**
   Already R4 **NOTE-ONLY**; shard 08 re-confirmed and did not re-flag.
   Fails G3 here because this repo wraps fuzzel in its own
   `options.mine.user.fuzzel.enable` rather than using the upstream
   `programs.fuzzel` tree at all — converting is an option-namespace reshuffle
   for a one-file payoff. Recorded for T13.
7. **`modules/niri/home.nix:47` hand-written `config.kdl` vs home-manager's
   `wayland.windowManager.niri`.** Already **explicitly rejected by R4**: the
   upstream module also takes over niri's systemd units and package, so this is
   a behaviour change, not an idiom swap. Shard 08 re-confirmed and did not
   re-flag. Do not put this on any list.
8. **`modules/helix/languages/default.nix` hand-maintained import list vs
   `builtins.readDir`.** (shard 01) Already alphabetically consistent, so C3's
   "consistently ordered" is met; deriving would obscure explicit
   enable/disable intent for a 15-entry table. **Fails G3.** (Contrast with the
   *aggregators*, where hand-listing produced real ordering bugs — see §6.)
9. **`modules/theme/home.nix` hand-written gtk.css / Kvantum text.** (shard 04)
   Checked against R4's fuzzel finding: **no freeform `programs.*.settings`
   replacement exists** for gtk.css or Kvantum, so this does not even reach
   R4 item 4's bar, let alone G3. Not a candidate, not merely deprioritized.
10. **`modules/fish/home.nix` theme rendered as hand-written text.** (shard 08)
    Checked: home-manager's `programs.fish` exposes no structured theme option.
    **Fails G4's "the replacement already exists" bar.**
11. **disko partition-key naming: `disk.main` (elitebook/t495/redtruck) vs
    `disk.disk1` (vps).** (shard 10) **Fails G3: no payoff to renaming a
    single-disk file.** Note only.
12. **elitebook's unencrypted root/swap** vs LUKS on t495 and redtruck.
    (shard 10) Reads as a deliberate per-machine security posture, **not drift**.
    Do not converge without asking the user.
13. **`modules/polkit_kde/home.nix:19` `/libexec/` path.** (shard 09) Outside
    R4's `bin/` signal; `getExe` does not apply. Not flagged.
14. **`modules/alacritty/linux.nix` naming.** (shard 08) This is a **C2 naming**
    observation, not G1 drift: `linux.nix` splits on a different axis than the
    `nixos.nix`/`darwin.nix` pairs elsewhere (it is a *home-manager-scope* file
    imported only by `modules/home.nix`, whereas `nixos.nix`/`darwin.nix` split
    *system-scope* config by OS — traced through all four aggregators). The two
    solve genuinely different problems, so there is no "converge on the newest"
    fix. It is a one-off (no other module uses `linux.nix`), so it is a one-line
    rename note (e.g. `alacritty/niri.nix`, naming what it actually gates on),
    not a structural finding.
15. **`# tun is needed for tailscale network` duplicated verbatim** across
    `jellyfin-server/nixos.nix:91`, `vikunja-server/nixos.nix:59`, and the
    immich/stalwart equivalents. (shards 05, 07) **Not an idiom finding at all** —
    there is no functional pattern to converge on. These are A1 comment cuts,
    handled per-file in §7.

---

## 4. Namespace summary (GATE 2 input; absorbs old T11)

The question GATE 2 has to answer: is there real namespace incoherence worth a
rename task, or is this a documented no-op? The walk's answer is **mostly a
no-op, with one confirmed cheap rename and one genuine disagreement between two
shards that this ledger does not resolve.**

Across all 11 shards, every `mine.system.*` option in a `nixos.nix`/`darwin.nix`
and every `mine.user.*` option in a `home.nix` predicted correctly, with the
exceptions below. Shard 09 (35 files) and shard 07 (7 files) each reported zero
misses; shard 04 and shard 06 reported zero misses in their own declarations.

### 4a. The disagreement: `mine.users.*` (plural)

**Two shards examined this and reached opposite conclusions. Both are recorded
in full. This ledger does not pick a winner — that is GATE 2's call.**

**Position A — shard 08: this is the sharpest namespace finding in the repo.**
> `modules/users/nixos.nix` declares `mine.users.*` (isSuperUser, description,
> hashedPasswordFile, uid, sshKeys, authorizedKeys, shell, home-modules) —
> **miss**: this is neither `mine.system.*` nor `mine.user.*`, it's a bare third
> top-level namespace (plural, sibling to `system`/`user` rather than nested
> under either). A reader following the `mine.system.*`/`mine.user.*` convention
> from every other module in this batch would not predict `mine.users.*` for
> system-level account declarations; it reads more like it should be
> `mine.system.users.*`.

Shard 08 also flagged its own limit, and that hedge is preserved: under "Could
not judge" it wrote that it "would need to check other modules outside this
batch for the same pattern before recommending a rename; flagged for GATE 2
rather than decided here." So Position A is a finding made *without* the
repo-wide view.

**Position B — shard 10: checked deliberately, cleared as a consistent third
top-level namespace.**
> Checked and ruled out as false positives: `mine.backups.*`/`mine.users.*` (a
> third top-level namespace used consistently across ~10 modules repo-wide per
> grep, not something this batch alone can judge as incoherent).

**Position B is corroborated by two more shards:**
- Shard 07: `mine.backups.*` (not `mine.system.backups.*`) "matches two other
  existing top-level precedents (`mine.users`, `mine.allowedUnfree`)... reads as
  an established, if narrow, third category rather than incoherence — not a
  rename candidate from this batch alone."
- Shard 11 (which owned `users/*.nix`): "`mine.users.<name>` (plural) is correct
  and matches where `modules/users/nixos.nix:17` and
  `modules/filesystems/nas.nix:77` declare `options.mine.users`... Both are
  internally consistent and correctly used everywhere checked, but the near-
  collision is a real readability tax — worth noting for GATE 2, not
  necessarily a rename."
- Shard 09: `mine.allowedUnfree` "sits directly under `mine.*`, not
  `mine.system.*`/`mine.user.*`, because it's genuinely shared across both
  scopes (per its own description). **Correct exception, not a miss.**"
- Shard 06 sits between the two: `modules/filesystems/nas.nix:80` declares
  `mine.users.<name>.nasAccess` under the plural registry, and shard 06 rated
  itself **medium confidence** on "whether the `mine.users` vs `mine.user` split
  is intentional-and-documented or accidental," explicitly declining to judge.

**Spot-check performed for this synthesis (neither shard's number, mine).**
`grep -rl 'mine\.users\b' --include=*.nix .` at `500ff35` → **6 files**:
`modules/users/nixos.nix`, `modules/filesystems/nas.nix`,
`users/{jellyuser,sumriri,sword,waktu}.nix`. Shard 10's "~10 modules" does not
hold for `mine.users` alone; it holds only if the three top-level namespaces are
counted together (`mine.backups` alone appears in 11 files). This weakens shard
10's *phrasing* without touching its substance: `mine.users` is used correctly
and identically at all 6 sites, and `mine.backups` really is used across 11.

**What is actually being decided.** The two positions do not disagree on any
fact. Both agree `mine.users.*` is used consistently and correctly everywhere it
appears. They disagree on whether *consistent-but-unpredictable* counts as a
defect under C4 ("a reader can predict whether a knob is `mine.system.*` or
`mine.user.*` without grepping"). The real decision for GATE 2 is therefore
**not** "is this incoherent" but:

> **Document the third top-level namespace, or rename it into the two-way split?**
>
> - **Document** (Positions B): add one line to the root README (T2) stating
>   that `mine.*` has three tiers — `mine.system.*` (machine policy),
>   `mine.user.*` (per-user home-manager toggles), and a small set of
>   scope-spanning registries directly under `mine.*` (`mine.users`,
>   `mine.backups`, `mine.allowedUnfree`). Cost: one sentence. C4 is then
>   satisfied by documentation rather than by structure, which is what C1/C4
>   jointly permit. Does not touch code, so `invariant: drvPath` is trivial.
> - **Rename** (Position A): `mine.users` → `mine.system.users`, and for
>   consistency `mine.backups` → `mine.system.backups`. Cost: 6 + 11 files,
>   plus `mine.allowedUnfree` which cannot move (shard 09 verified it is
>   genuinely scope-spanning by its own docstring), so the rename **does not
>   eliminate the third tier — it only shrinks it to one member**, which is
>   arguably a worse outcome than either extreme.
>
> That last point is the ledger's one editorial observation, and it is offered
> as an argument, not a verdict: a rename that leaves `mine.allowedUnfree`
> stranded still requires the README line, so the README line is unavoidable
> either way.

Secondary, and unaffected by the above: the `mine.users` (plural, account
registry) / `mine.user` (singular, ~15-site home-manager toggle) pair differ by
one letter. Shard 11 calls this "a real readability tax" independently of which
option GATE 2 picks. If the rename option is chosen, this is a free side benefit;
if the document option is chosen, the one-letter collision is the thing the
documentation most needs to call out.

### 4b. The confirmed miss

**`mine.system.teamspeak-client.enable`** — shard 10, verified for this
synthesis at `500ff35`.
- Declared: `modules/teamspeak-client/nixos.nix:12`.
- Call sites: `hosts/redtruck/default.nix:130`, `hosts/t495/default.nix:47`.
- Evidence: the entire `config` block is
  `mine.allowedUnfree = [ "teamspeak6-client" ];` plus
  `environment.systemPackages = [ pkgs.teamspeak6-client ];`. No service, no
  unit, no per-user state, nothing system-shaped at all.
- Why it is a miss: every other *client app* in this repo lives under
  `mine.user.*` — alacritty, firefox, mako, lazygit, gh, git, hyprlax,
  swaylock, obs-studio, keybase. A reader scanning host files would predict
  `mine.user.teamspeak-client` and be wrong.
- Cost: one option, two call sites. Shard 10: "a genuine, cheap rename
  candidate, not a documented no-op."
- Caveat for whoever does it: the module currently writes
  `environment.systemPackages` (system scope). Moving the *option* to
  `mine.user.*` means moving the file to `home.nix` and the package to
  `home.packages`, which is a behaviour change (per-user rather than
  system-wide install), not a pure rename. Neither shard noted this; flagged
  here so GATE 2 prices it correctly.

### 4c. Checked and cleared (record these so they are not re-opened)

| namespace | shard | why it is not a miss |
|---|---|---|
| `mine.allowedUnfree` | 09 | genuinely scope-spanning, self-documented in its own `description`. Correct exception. |
| `mine.backups.*` | 07, 10 | same third-tier category as `mine.users`; consistent across 11 files. Subject to §4a's decision, not a defect on its own. |
| `mine.system.theme.*` | 04 | theming *looks* per-user, but the options it declares are system-scoped (`fontconfig.defaultFonts`, `programs.dconf.enable`, system `qt.*`). "A reader predicting `mine.user.theme` would be wrong but not unreasonably so." **Not a miss**, but the closest thing to one in that batch. Shard confidence **medium** — a judgment about reader expectation, not a rule violation. |
| `mine.system.paseo-desktop.enable` on mac | 10 | looks like a miss (elsewhere it is `mine.user.paseo-desktop`) but is an intentional darwin forwarding shim: `modules/paseo-desktop/darwin.nix:5,11` defines a system-level trigger that forwards to `mine.user.paseo-desktop.enable` internally, because the homebrew cask needs a system-level install. **Not a finding.** |
| `mine.system.devboxes.*` | 03 | host-level container infrastructure. Predicts correctly. |
| `mine.system.local-llm.{enable,cuda.enable}` | 02 | GPU container + systemd service, machine-level. No miss. |
| `mine.system.*` in `modules/system/nixos.nix` | 04 | every option genuinely machine-level; explicitly **does not** corroborate FINDINGS.md's suspicion. |
| `mine.user.*` across shard 09's 35 files | 09 | zero misses. |
| `mine.system.*` across shard 07's 7 service modules | 07 | zero misses. |
| `mine.user.polkit-kde` (dir is `polkit_kde`) | 09 | a **C2 file-naming** mismatch (already T4's job: `polkit_kde` → `polkit-kde`), not a namespace-tree miss. |

### 4d. Not judged

- Whether the third top-level tier is *deliberate repo-wide policy* or accreted.
  No shard could answer this from the code alone — nothing in the repo documents
  it (there is no root README; rubric C1). Shard 08 and shard 06 both said so
  explicitly. **This is a question for the user, not for a grep.**

---

## 5. Relocation inventory

**Read this caveat first.** Shards proposed several different `docs/` paths for
the comment clusters below. Those paths do not agree with each other, and more
importantly **the destination is an open decision, because T3 deletes the only
`docs/` directories that currently exist.** Per `PLAN.md:61-64`, T3 is
"**DECIDED: delete `docs/superpowers/` and `docs/local-llm-review-2026-09-01/`
outright**", and `docs/repo-hygiene/` (this directory) is deleted by T12 per
rubric D5. After T3 and T12 the `docs/` tree is empty except for whatever T2
puts there (`docs/new-host.md`).

This section therefore **inventories the shards' proposals faithfully and
invents no scheme**. Two of the proposed destinations point at content T3 is
about to delete, which is a sequencing hazard flagged below and not silently
fixed here.

Total: **13 comment clusters, 229 comment lines**, verified line-by-line at
`500ff35` (every range below is 100% comment lines except two, noted).

| # | source | lines | span | shard's proposed destination |
|---|---|---|---|---|
| 1 | `modules/local-llm/models.nix:28-35` | 8 | maxModelLen/headroom interaction essay | `docs/local-llm-review-2026-09-01/` (shard 02) — **T3 deletes this** |
| 2 | `modules/local-llm/models.nix:37-44` | 8 | `headroom` drift-margin essay | same — **T3 deletes this** |
| 3 | `modules/local-llm/models.nix:117-126` | 10 | no-speculativeTokens / MTP paragraph | **in-repo**: consolidate into `modules/local-llm/nixos.nix:45-62`, which owns the image pin and the re-enable gate; leave a pointer here |
| 4 | `modules/local-llm/models.nix:130-136` | 7 | deleted-alias backstory ("44k fan-out budget lived here") | **CUT, not relocate** — pure A2 history, git log has it. Keep one line of forward-looking guidance ("if a second budget is wanted, add it as an alias") |
| 5 | `modules/devbox/plugins.nix:16-44` | 29 | "REMOVING ONE, AND CLEANING UP AFTER IT" runbook — state-file paths, `pi remove` steps, the superpowers→subagents tool-name collision | `docs/devbox/pi-plugin-removal.md` (shard 03) — **path does not exist**; shard rated this **medium confidence** ("a plausible doc path is suggested, not verified against existing `docs/` structure") |
| 6 | `modules/devbox/plugins.nix:46-50` | 5 | restates the file's own header (`:1-6`) | **CUT the restatement**; keep only the cross-reference to `pi-coding-agent/settings.nix` |
| 7 | `modules/devbox/plugins.nix:52-62` | 11 | pi-subagents vs pi-superagents-fork justification | trim to a pointer at `docs/superpowers/specs/2026-08-31-nested-orchestrator-plan.md` (shard 03) — **T3 deletes that file**. Sharpest sequencing hazard in this table: the shard's proposal is to replace 11 lines of in-code reasoning with a pointer to a doc that is about to be deleted. |
| 8 | `modules/pi-coding-agent/settings.nix:10-29` | 20 | `inputsOf` vision-gating rationale, cites `openai-completions.js:1021`/`:70` | a doc (shard 04, **no path named**). Shard notes this content may already exist as the user's `pi-vision-propagation-gap` memory note, and rated itself **medium-high**: "could not verify whether the vision-gating content actually duplicates a `docs/` file or only a memory note — flagged as check-before-cutting, not asserted as fact." |
| 9 | `modules/pi-coding-agent/settings.nix:95-125` | 28 (span 31) | `subagents` essay: `resolveEffectiveSubagentModel` precedence, `modelSource.type`, why no `defaultModel`/`defaultThinking` — 30 lines guarding a 2-line config value | "a doc on pi-subagents routing" (shard 04, **no path named**). Keep in place: the one-line fact that `maxThinking` is a ceiling. |
| 10 | `modules/pi-coding-agent/settings.nix:179-205` | 27 | `webSearch.provider` rationale — mixes A2 history (exa keyless endpoint) with A5 design prose (auto vs all) and a how-to | a doc (shard 04, **no path named**). Keep in place: "explicit list needed — `auto`/`all` both collapse to exa alone with no keys set", adjacent to `provider = [...]`. |
| 11 | `modules/stalwart-server/nixos.nix:1-23` | 22 (span 23) | bring-up runbook: container login, tailscale-serve port choice (`--https=8443` collision avoidance), first-login UI walkthrough | "a `docs/` runbook" (shard 05, **no path named**). Shard rated the destination **medium confidence** and said so: "no `docs/` runbook directory currently exists for per-service bring-up steps... that's a T13-level call, not this file's." Explicitly RELOCATE, **not CUT** — too operationally load-bearing to delete. |
| 12 | `modules/caddy/nixos.nix:1-20` | 20 | design-doc prose on the routing model, the port-80 challenge lane, the 127.0.0.1-address regression, plus an A2 fragment (the Stalwart auto-ban incident) | "a caddy-edge operations doc under `docs/`" (shard 06, **no path named**). Shard: "assumes a destination doc doesn't yet exist for this edge — didn't find one to confirm the target path, only that `docs/` is the right tier." RELOCATE not CUT — live operational context for the caddy-l4 passthrough. |
| 13 | `hosts/redtruck/default.nix:16-49` | 34 | container secret-mount contract, per-secret-type mode/owner rationale, rotation instructions | **in-repo**: `modules/devbox/nixos.nix`, next to the `mine.system.devboxes` doc header (`:1-17`) and the `githubTokenFile` etc. `description` strings (~`:60+`). This is the same move as §2a item 4 — a responsibility relocation that happens to be all comment. |

**Breakdown of the 229 lines by destination type:**
- **44 lines** move within the repo, to a named existing file (#3 → `local-llm/nixos.nix`, #13 → `modules/devbox/nixos.nix`). These are unblocked by the `docs/` decision.
- **12 lines** are CUT or trim-in-place, not relocation at all (#4, #6). Also unblocked.
- **173 lines** across 7 clusters (#1, #2, #5, #7, #8, #9, #10, #11, #12) want a
  `docs/` destination that either does not exist or is scheduled for deletion.
  **These are blocked on a decision nobody has made.**

**Borderline clusters — recorded, not counted in the 229.** Four service modules
carry a short bring-up runbook as a file header. Shard 05 judged these
individually and declined to flag them as RELOCATE, noting that "every service
module in this batch carries the same shape" and treating them as per-module
"how to operationally reach this thing" doc-comments rather than code
commentary. Verified spans: `modules/dns-server/nixos.nix:1-10` (10 lines),
`modules/teamspeak-server/nixos.nix:1-7` (7), `modules/jellyfin-server/
nixos.nix:1-5` (5), `modules/terraria-server/nixos.nix:1-4` (4) — 26 lines total.
If T13 ever creates a service-runbook doc, these join #11 and #12; until then
they are keeps. Shard 05 flagged exactly this dependency.

**The open decision, stated plainly.** Nine of the thirteen clusters name a
`docs/` destination. No two shards named the same path, three named no path at
all, one named a path T3 deletes, and two named a directory T3 deletes. The
shards were right to propose destinations — TW's acceptance criterion is that
naming the destination is the point — but they each had only their own batch's
view and none of them had `PLAN.md`'s T3 decision. **A single relocation
destination must be decided before any of these 173 lines move, and it cannot be
under `docs/superpowers/` or `docs/local-llm-review-2026-09-01/`.** This ledger
deliberately does not pick one.

---

## 6. Live bugs and defects

Things that are broken, mis-ordered, or impossible-to-configure right now — as
distinct from everything above, which is hygiene. These should be fixed on their
own merits regardless of what the plan decides about comments and namespaces.

**B1. `modules/nixos.nix` — three import-ordering violations.** (shard 11 found
two; the third was found spot-checking for this synthesis.) The list is
otherwise strictly alphabetical, so each of these is a genuine break in the only
convention the file has:
- `./devbox/nixos.nix` (line **21**) sits after `./openssh/nixos.nix` (line 20).
  It belongs between `./dns-server` (8) and `./docker` (9).
- `./pipewire/nixos.nix` (line **22**) sits before `./photoform/nixos.nix`
  (line 23). "photoform" < "pipewire" — these two are swapped.
- **NEW:** `./jellyfin-server/nixos.nix` (line **14**) sits before
  `./jellybox/nixos.nix` (line **15**). "jellybox" < "jellyfin" — swapped.

Severity: cosmetic on its own. It matters because it is evidence for T10 — a
hand-maintained list produced three ordering errors that three separate reviews
did not catch, and shard 11's recommendation follows from exactly that: derive
at least `nixos.nix` and `home.nix` (`lib.filesystem.listFilesRecursive`, or an
explicit allowlist-by-exception for the modules that must stay opt-in, e.g.
`pi-coding-agent`) so this class of error becomes structurally impossible.
`modules/darwin.nix`, `modules/home-darwin.nix` and `modules/home.nix` were all
checked and are correctly alphabetized — no findings there.

**B2. `modules/theme/home.nix` orphan — RETRACTED, see §1.1.** Shard 11 reported
this as a live bug ("every Linux host is silently missing GTK/QT/cursor
theming"; "the single most valuable finding in this shard"). The spot-check
contradicts it: `modules/theme/nixos.nix:36-37` wires the file via
`home-manager.sharedModules` inside `config = mkIf cfg.enable`, and both
`hosts/redtruck/default.nix:124` and `hosts/t495/default.nix:33` set
`mine.system.theme.enable = true`. **This is not a bug.** It is listed here only
so that a reader who encounters shard 11's version in §7 finds the retraction
next to it. The one true residue — `hosts/elitebook/default.nix` never enables
the theme module, so elitebook has no GTK/Qt/cursor/font theming — is a host
policy question for the user, not a defect.

**B3. `modules/system/darwin.nix:5` makes the darwin `drvPath` a function of the
commit hash.** (shard 04) The line is
`system.configurationRevision = inputs.self.rev or inputs.self.dirtyRev or null;`
and it carries **no comment**. Per this plan's own build-invariant work, this is
what broke the `invariant: drvPath` check for darwin until it was worked around.
Shard 04 classified this precisely: it is a *missing* rubric-A keep (a
load-bearing constraint on nearby code that is currently silent), not an extra
comment to cut. The fix (drop it / gate it / accept the instability) is a
decision, not a cleanup, and shard 04 correctly declined to make it from a
read-only walk. **Anyone running `invariant: drvPath` on `darwinConfigurations`
needs to know about this line before they start.**

**B4. `modules/jellyfin-server/nixos.nix` cannot be run tailnet-only.**
(shard 07) The LAN firewall opening, the NAT port-forward (`:55-62`) and the
container's own `allowedTCPPorts` (`:152`) are all unconditional. A host that
wants jellyfin reachable only over the tailnet must edit the module — there is
no option. Its three sibling `*-server` modules all offer a way (teamspeak via
`publicAccess`/`tailscaleAccess`, terraria and vikunja by being tailnet-only by
construction). Whether to *change* this is a product decision (§3a A6); that a
host currently has no way to express the preference is a capability gap in the
module's interface, and that half is not a judgment call.

**B5. `modules/devbox/container.nix:53` would break if converged naively.**
(shard 03, verified) Not currently broken — flagged because it is a trap for
whoever actions §3a A1. `piWrapped` is a `symlinkJoin` named `"pi-wrapped"` with
no `meta.mainProgram`, so `lib.getExe piWrapped` resolves to a `bin/pi-wrapped`
that does not exist. `meta.mainProgram = "pi";` must be added to the derivation
first. Same class of trap, unverified rather than verified: `swaylock-effects`
(`swayidle/home.nix:13`) and `mpls` (`helix/languages/markdown.nix:18`).

**B6. Duplicated knowledge that will drift.** (shard 02) The MTP /
prefix-caching rationale is maintained in two files:
`modules/local-llm/models.nix:117-126` and `modules/local-llm/nixos.nix:49-58`.
Not broken today; the same fact in two places is a defect in waiting. Shard 02's
call, preserved: `nixos.nix` should be canonical, because that is where the
image pin and the re-enable gate actually live. Same shape, smaller, in
`modules/users/nixos.nix:110-113` vs `modules/users/darwin.nix:13-15` (the
unfree-bridge comment, near-verbatim in both).

**Not bugs, checked:** the four `hardware-configuration.nix` files are generated
(each says so on line 1) and are out of scope for editing, not defects.
`modules/homebrew/darwin.nix` declares no `mine.*` enable option and is
unconditional — shard 09 checked this and called it "the one outlier in the
batch," by design, not a defect.

---

## 7. Per-file sections

The 11 shards as written, in order. Headings are demoted one level to nest under
this section; **no judgement, hedge, or citation has been altered**. Where a
shard's claim was contradicted by a spot-check, the correction is in §1 and is
cross-referenced from §6 — the shard's original text is left standing below so
the disagreement stays visible.

Batch coverage: 01 `modules/helix` (17) · 02 `modules/local-llm` (5) ·
03 `modules/devbox` (4) · 04 `modules/{pi-coding-agent,system,theme}` (10) ·
05 `modules/{dns,immich,stalwart}-server` (3) ·
06 `modules/{caddy,filesystems,firefox,photoform}` (8) ·
07 `modules/{backups,jellybox,jellyfin,teamspeak,terraria,vikunja}` (7) ·
08 `modules/{_1password,alacritty,fish,fuzzel,niri,paseo-desktop,users}` (14) ·
09 `modules/*` avahi→unfree (35) · 10 `hosts/*` (15) ·
11 flake plumbing, aggregators, `users/*`, `tests/*` (14). **Total 132.**


---

### Ledger batch 01 — modules/helix (17 files)

#### modules/helix/home.nix
1. **Purpose**: enable and configure the Helix editor as a home-manager program.
2. **Does**: declares `mine.user.helix.enable`; sets `programs.helix.settings` (theme, editor UI tweaks) and a custom `catppuccin_mocha_transparent` theme override; imports `./languages`. All facets of "turn Helix on with my preferences" — **coherent**.
3. **Comments**: none.
4. **Idiom**: none — no hand-built paths, no freeform-config opportunity beyond what home-manager's `programs.helix` already provides.
5. **Namespace**: `mine.user.helix.enable` — predictable as `mine.user.*` (home-manager program). No misses.
6. **Confidence**: high.

#### modules/helix/languages/default.nix
1. **Purpose**: aggregate the per-language Helix LSP modules into one import list.
2. **Does**: one `imports` list, alphabetically ordered (css → yaml), 15 entries matching the 15 sibling files below — pure aggregator, nothing else. **Coherent**.
3. **Comments**: none.
4. **Idiom**: hand-maintained but already alphabetically consistent (rubric C3 asks for "consistently ordered" — met; "ideally derived" is a nice-to-have, not cited here since a `builtins.readDir`-derived import list would obscure explicit enable/disable intent for a 15-entry table — not worth chasing per G3).
5. **Namespace**: n/a, declares no options.
6. **Confidence**: high.

#### The 16 near-identical `languages/*.nix` files (all but default.nix)
Shared shape, checked file by file: `css.nix graphql.nix html.nix javascript.nix json.nix jsx.nix kdl.nix markdown.nix nix.nix python.nix rust.nix toml.nix tsx.nix typescript.nix yaml.nix` — 15 files (one per language), each declares `mine.user.helix.lsp.<lang>.enable` (+ occasional sibling option), gated `config = mkIf cfg.enable { programs.helix = { languages...; extraPackages = ...; }; }`. This is rubric B4's textbook table: same-kind entries, one per language, coherent by definition. Verdict for all 15: **table**. No comments in any of them (0/0 — nothing to flag under rubric A). Namespace: all sit under `mine.user.helix.lsp.<lang>.*`, consistent and predictable as `mine.user.*` (home-manager program config) — no misses across the set.

Per-file purpose/does, one line each (all coherent/table, no exceptions):
- **css.nix**: CSS(+SCSS) LSP via vscode-css-language-server, optional Tailwind intellisense toggle (`enableTailwind`).
- **graphql.nix**: GraphQL formatting only, no language-server block (uses `graphql-language-service-cli` package + prettier formatter).
- **html.nix**: HTML/templates via `superhtml` LSP+formatter, optional Tailwind toggle — near-mirror of css.nix's Tailwind pattern.
- **javascript.nix**, **json.nix**, **jsx.nix**, **tsx.nix**, **typescript.nix**: the TS-ecosystem cluster (biome + typescript-language-server), see duplication finding below.
- **kdl.nix**: kdlfmt formatter only, no language-server.
- **markdown.nix**: marksman + mpls language-servers; mpls path hand-built (see idiom finding below).
- **nix.nix**: nixfmt formatter, nil LSP implicit via helix defaults.
- **python.nix**: ruff only, no explicit language-server block (relies on helix's built-in pyright/ruff wiring).
- **rust.nix**: rust-analyzer clippy check override + rust toolchain packages.
- **toml.nix**: taplo formatter only.
- **yaml.nix**: yaml-language-server + prettier formatter.

**Exceptions worth naming**: `typescript.nix` is the one file in the cluster with a real option beyond `enable` (`formatter = enum ["biome" "prettier"]`), making its `config` block an `if/else` instead of the cluster's flat biome default — legitimate extra facet of the same "typescript LSP" job, still coherent, not overloaded.

##### Duplication finding (G1, cross-file — the one this batch is for)
`javascript.nix:18-26`, `json.nix:17-25`, `jsx.nix:16-24`, `tsx.nix:17-25`, `typescript.nix:34-42` all repeat, byte-for-byte, the same `language-server` block:
```
biome = { command = "biome"; args = [ "lsp-proxy" ]; };
typescript-language-server.config.tsserver.path = "${pkgs.typescript}/lib/node_modules/typescript/lib/tsserver.js";
```
and the same `extraPackages = with pkgs; [ biome typescript-language-server typescript ];` (4/5 identical; typescript.nix adds a conditional `prettier`). Additionally `json.nix`, `jsx.nix`, `tsx.nix`, `typescript.nix` repeat an identical biome-formatter shape differing only in the `--stdin-file-path file.<ext>` extension. Five files hand-copy one "TS-ecosystem language wiring" recipe — a real candidate for a shared `let`-bound helper (e.g. a `mkTsBiomeLanguage { name, ext, extraServers ? [] }` in `languages/default.nix` or a `lib.nix` sibling), which would also remove the drift risk already visible: `typescript.nix`'s formatter logic diverged from the other four (`if cfg.formatter == "biome" then ... else ...`) without the sibling files getting the same option. Meets G3: shorter (removes ~8 duplicated lines × 5), harder to get wrong (one recipe instead of five hand-kept copies). Secondary, smaller instance of the same pattern: `css.nix:40-42,72` and `html.nix:25-27,52` both hand-duplicate the "`tailwindcss-language-server = mkIf cfg.enableTailwind {...}` + `optional cfg.enableTailwind tailwindcss-language-server`" pair — two sites, same recipe, lower priority than the five-file TS cluster.

##### Idiom finding (R4 G1-1 extension)
`markdown.nix:18` — `command = "${pkgs.mpls}/bin/mpls";` is a hand-built `${pkg}/bin/x` path, the same pattern R4 already flagged elsewhere (reference: `lib.getExe pkgs.foo`, newest at `modules/local-llm/vllm-service.nix:17`). Not in R4's cited list, but same defect: replace with `lib.getExe pkgs.mpls` (package's bin name matches pname `mpls`, confirmed no other bin present per package derivation naming). Meets G3: shorter, matches house style used 15+ other places in-repo.

6. **Confidence**: high on structure/namespace/duplication; the mpls-package bin-name assumption (single `bin/mpls` output) was checked only by grep of local module files, not by inspecting the mpls derivation itself in nixpkgs, so treat that one line as a should-verify-before-applying, not a should-not-flag.

---

### Ledger batch 02 — modules/local-llm/{container,models,nixos,vllm-service,weights}.nix

#### modules/local-llm/container.nix

**Purpose.** The NixOS config for the nspawn guest that fronts vLLM over the tailnet.

**Does.**
- Enables tailscale (tailnet front door) — in scope.
- Configures open-webui as a client of the host's vLLM endpoint — in scope.
- Networking/firewall (DNS, IPv6 off, allowed ports, trusted iface) — in scope, guest-local policy.
- Unfree predicate for open-webui — in scope, needed for this package.
Verdict: **coherent** — one job (the guest side of the split), all entries are facets of it.

**Comments.** 8 comment lines. 1 keep (header, lines 1-5): explains the host/guest split, load-bearing context for why vLLM isn't here — passes the "operational knowledge" test. 1 keep (lines 36-38): explains why 8081/llama-swap port is gone and why nothing else needs opening — load-bearing on the firewall block above it. 0 clearly-cut (A1/A2/A3) found; both surviving comments earn their place.

**Idiom.** None found in this file.

**Namespace.** N/A — this file declares no `mine.*` options (it's a container's own NixOS config, not a host-level module).

**Confidence.** High.

---

#### modules/local-llm/models.nix

**Purpose.** Pure-data catalog of servable models: weights, sizing, and vLLM/pi tuning per entry.

**Does.**
- Provider/baseUrl for the pi client — in scope (catalog metadata).
- Per-model `files` (HF filename → hash) — in scope, this is the point of the file.
- Per-model sizing (`maxModelLen`, `headroom`, `maxTokens`), `sampling`, `thinkingLevels`, `vision`, `vllm.*` tuning — in scope, this is model-specific config the catalog exists to hold.
- `enabled`/`default` list selection — in scope, selects what nixos.nix/vllm-service.nix act on.
Verdict: **table** (B4) — three model entries, each entry the same *kind* of thing (a model's identity + tuning). Long, but one shape repeated, not several responsibilities. Not overloaded: nothing here is arguably somebody else's job (no imperative logic, no service wiring — that's nixos.nix/vllm-service.nix).

**Comments.** 39% of lines (103/261) are comments — well above the ~30% smell threshold, but per-comment judgment, most are the "operational knowledge you cannot get back" keep-type, not restatement/history/prose-about-design:
- KEEP-IN-PLACE (load-bearing on the adjacent line, short, would take real effort to re-derive from a clean vLLM instance): `kvCacheDtype` fp8 caveat (line 109-110, "never pair with --calculate-kv-scales"), `maxNumBatchedTokens` pool-tradeoff (96-107, includes the specific 40%-too-small measurement caveat), `maxNumSeqs` knee (90-94), `toolCallParser` choice (112-114, qwen3_coder hangs/garbage), `thinkingLevels` low-is-banned rationale (54-58), vision `count`-is-per-prompt semantics and the 2026-09-01 lockup (72-79), `fp8 kv caused incoherent output on this MoE` (247).
- RELOCATE — these read as design docs, not per-line comments, and duplicate what's already promised to live under `docs/local-llm-review-2026-09-01/`: the `maxModelLen`/headroom interaction essay (28-35), the drift-margin essay on `headroom` (37-44), the deleted-alias history note (130-136, this is pure A2 history — belongs in git log, not in the file). Recommend trimming each to one line ("see docs/local-llm-review-2026-09-01/NN for sizing rationale") and moving the full reasoning into that doc if it isn't already there.
- CUT (A2, pure history, git already has it): line 130-136 in full is a corpse of a deleted feature explaining why it was deleted — the "if a second budget is wanted, add it as alias" guidance is fine to keep in one line, but the "44k fan-out budget lived here" backstory is git-log material.
- Borderline, unsure — flagging rather than deciding: the no-speculativeTokens/MTP paragraph (117-126) is both operational (why MTP is off, re-enable gate) and partially duplicated verbatim in nixos.nix's header comment (see nixos.nix section below) — this is a KEEP but the duplication across two files is itself a finding (same knowledge maintained in two places will drift). Recommend consolidating to one canonical location (nixos.nix, since that's where the image pin/gate actually lives) and shortening the models.nix copy to a pointer.

**Idiom.** None found — pure data, no code patterns to check against R4.

**Namespace.** N/A — no `mine.*` options declared; this is imported data, not a module.

**Confidence.** High on structure/verdict. Medium on the RELOCATE targets — I did not verify whether `docs/local-llm-review-2026-09-01/` actually already contains the sizing rationale the comments claim it does; if it doesn't, these are KEEP-IN-PLACE instead of RELOCATE.

---

#### modules/local-llm/nixos.nix

**Purpose.** Host-level NixOS module wiring the local-llm nspawn container plus the host-side podman/vLLM service around it.

**Does.**
- `options.mine.system.local-llm.{enable,cuda.enable}` — in scope, this is the module's own interface.
- Assertions tying models.nix's catalog shape to what podman/pi can actually consume — in scope, this is exactly the kind of cross-cutting validation a module should own.
- `hardware.graphics`, firewall/NAT for the guest's 8080 — in scope (host-side networking the container needs).
- `systemd.services.vllm-image-pull` (pull the pinned OCI image) — in scope, host-side lifecycle for the podman service this module also enables.
- `containers.local-llm` (the nspawn container definition, device passthrough, bind mounts) — in scope, wiring the guest in.
- Imports and wires `vllm-service.nix` (`systemd.services.vllm`) — in scope, this module is the assembly point.
Verdict: **coherent** — every entry is either this module's own option surface or the host-side wiring needed to stand the container + service up together; B6 (options/config split) is respected (options block is separate and small).

**Comments.** 94 lines, 35% of file. Breakdown:
- KEEP-IN-PLACE, high value, hard to re-derive: the vLLM image pin rationale (45-62) — names the exact upstream PR/issue numbers (#51113, vllm#47194, vllm#43559, #50991), the measured 3.04 tok/decode-step MTP number, and the re-enable gate condition. This is precisely rubric A's "operational knowledge you cannot get back" — losing the issue numbers means re-discovering them from scratch in the vLLM tracker.
- KEEP-IN-PLACE: metrics-scraping header (1-29) — explains the `/metrics` one-shot-snapshot policy and *why* there's deliberately no scraper; this is a load-bearing design decision for anyone tempted to add a Prometheus scrape.
- KEEP-IN-PLACE, short and load-bearing: `cuda.enable` comment (41-42, GPU gating rationale), the "no swapper, one model" assertion comment (122-130, explains a non-obvious invariant), name-charset assertion comment (136-139, explains why it exists), podman-socket bind-mount removal note (176-186, explains a security-relevant change, though borderline A2 — recommend trimming to the current state + one-line "why" and dropping the "It used to be launched..." narrative into git log; partial CUT-and-trim).
- RELOCATE (duplication with models.nix, see above): the MTP/prefix-caching rationale here (49-53, 55-58) substantially overlaps models.nix lines 117-126. Since nixos.nix owns the actual re-enable gate (the image pin), recommend this file be the canonical copy and models.nix's copy be trimmed to a pointer here.
- A1/restatement, low-value: none flagrant found; this file's comments all carry non-obvious information, not restatement.

**Idiom.**
- **G1 hit (matches R4 item 1 exactly).** `nixos.nix:214`: `ExecStart = "${pkgs.podman}/bin/podman pull ${vllmImage}";` hand-builds the binary path. The same module directory's newer file, `modules/local-llm/vllm-service.nix:17`, already spells this `podman = lib.getExe' pkgs.podman "podman";` and reuses `podman` at lines 83 and 128. Since `vllm-service.nix` is R4's cited reference spelling (added 2026-09-01, newest in this directory), `nixos.nix:214` should converge to `lib.getExe' pkgs.podman "podman"` — shorter, and removes a hand-rolled `/bin/` join. Clears G3 (shorter, matches the already-used-in-this-dir pattern) and G4 (cites file:line + replacement + where the replacement already lives, same directory).

**Namespace.** `mine.system.local-llm.enable` and `mine.system.local-llm.cuda.enable` — both read as `mine.system.*` correctly: this is host/system-level infrastructure (a container + GPU passthrough), not a per-user preference. No miss.

**Confidence.** High on verdict and the idiom finding (directly confirms R4's own citation). Medium on which narrative-history comments are safe to trim vs. genuinely load-bearing — flagging the podman-socket paragraph (176-186) as one to have a second reader confirm before cutting the historical part.

---

#### modules/local-llm/vllm-service.nix

**Purpose.** Builds the systemd unit that runs vLLM for the catalog's default model as a host podman container.

**Does.**
- Derives podman/vLLM CLI args from the catalog entry (`m = catalog.models.${name}`) — in scope, this is the file's job (catalog entry → unit).
- Builds `start`/`waitHealthy` shell scripts — in scope, mechanics of running that command under systemd.
- Assembles the `systemd.services.vllm`-shaped attrset (unit deps, ExecStart/Stop, timeouts, restart policy) — in scope.
Verdict: **coherent** — single translation step (catalog → unit), B5 sentence: "turn one catalog entry into the vllm systemd unit."

**Comments.** 36 lines, 26% of file — under the 30% smell line, and content matches. Mostly KEEP-IN-PLACE:
- `mmLimit` comment (24-28): explains that width/height are profiling hints not a hard cap, and points at the measurements doc — keep, non-obvious and load-bearing on the line below.
- prefix-caching/mamba-align comment (51-55): explains the `block_size <= max_num_batched_tokens` assert that would otherwise surface as an opaque vLLM crash — keep, exactly the "vendor quirk that will bite the next reader" case from rubric A.
- `--log-driver=none` comment (64-65) and `-p hostAddress` comment (71-72): both short, adjacent, load-bearing — keep as-is.
- `waitHealthy` comment (92-95): explains why it bails on process death rather than polling — keep, non-obvious concurrency hazard (racing KV profiling).
- `Type=exec` comment (123-124) and `TimeoutStartSec` comment (129-130): short, load-bearing on the line below — keep.
No A1/A2/A3 cut candidates found in this file; it's denser but every comment earns its place.

**Idiom.** This file is R4's cited reference spelling for `lib.getExe'`/`lib.getExe` (lines 17, 91, 96, 100, 101) — nothing to fix here; it's the target other files should converge toward (see nixos.nix finding above).

**Namespace.** N/A — declares no `mine.*` options; it's a pure builder function consumed by nixos.nix.

**Confidence.** High.

---

#### modules/local-llm/weights.nix

**Purpose.** Turns one catalog model entry into a store path of its fetched HuggingFace files.

**Does.**
- `linkFarm` of `fetchurl`'d blobs keyed by filename — the entire file, one job.
Verdict: **coherent** — trivially, B1 (one entry).

**Comments.** 2 lines, both keep: line 1 states the file's purpose (fine, not restatement of code — code is a lambda, comment states intent), line 2 explains *why* linkFarm (store dedup, partial-retry-per-shard) — short, non-obvious, load-bearing. Neither is A1/A2/A3.

**Idiom.** None found.

**Namespace.** N/A — no options declared.

**Confidence.** High.

---

#### Idiom summary (cross-file, this batch)

**G1 confirmed within this directory, not just cited by R4:** `modules/local-llm/nixos.nix:214` hand-builds `"${pkgs.podman}/bin/podman"` for `vllm-image-pull`'s `ExecStart`, while `modules/local-llm/vllm-service.nix:17` (same directory, newer file, added 2026-09-01) already spells the identical package+binary as `lib.getExe' pkgs.podman "podman"` and reuses it three more times in the same file (lines 83, 128 use the bound `podman` variable, and lines 91/96/100/101 use `lib.getExe'`/`lib.getExe` for coreutils/curl). This is the sharpest possible G1 case: the reference spelling and the divergent spelling sit in the same directory, one file old-style, one new-style, doing analogous work (both build podman/coreutils invocations for systemd units in this module). Convergence target: `nixos.nix:214` → `"${lib.getExe' pkgs.podman "podman"} pull ${vllmImage}"`.

No other idiom drift found in this batch beyond what R4 already lists.

#### Namespace summary (cross-file, this batch)

Only `nixos.nix` declares options (`mine.system.local-llm.enable`, `mine.system.local-llm.cuda.enable`), both correctly under `mine.system.*` — this is machine/infrastructure config (GPU container, systemd service), not user preference. No incoherence in this batch; nothing for GATE 2 to weigh from these 5 files.

---

### Ledger batch 03 — modules/devbox (agents.nix, container.nix, nixos.nix, plugins.nix)

#### modules/devbox/agents.nix

1. **Purpose.** Factory for agent-launcher wrapper scripts that load direnv before exec'ing the real binary.
2. **Does.** One thing: `mkAgent` closure producing a `writeShellScriptBin`. **Verdict: coherent.**
3. **Comments.** 8/31 lines (26%). Header (1-4): operational fact about paseo spawning as child processes so direnv never fires — KEEP (vendor quirk, load-bearing). Args comment (11-14): explains why `args` is interpolated into both exec paths — KEEP, short, load-bearing on the two exec lines below it. None fail rubric A.
4. **Idiom.** `lib.getExe pkgs.direnv` (18, 29) already idiomatic — this file is the reference-quality example, not a divergence.
5. **Namespace.** Declares no options.
6. **Confidence:** high.

#### modules/devbox/container.nix

1. **Purpose.** The NixOS system config for one devbox container instance (analogous to a host's `default.nix`, consumed via `plugins.nix`'s `config = import ./container.nix {...}`).
2. **Does** (responsibility audit): agent CLI wrappers/settings (piWrapped, ghWrapped, claudeSettings, agentPkgs, envContract) · user account · nix registry/settings · systemPackages · home-manager profile for `agent` (direnv, git signing, claude settings activation) · paseo service + secret-handling hardening · tailscale/networking/firewall · boot-time tmpfiles. **Verdict: overloaded**, two foreign responsibilities:
   - Agent-tooling definitions (`piWrapped` 33-40, `ghWrapped` 59-62, `claudeSettings` 76-82, `agentPkgs` 42-55) belong in **`modules/devbox/agents.nix`**, which already exists for exactly this ("Agent launchers for the devbox container") — container.nix currently duplicates that file's job instead of using it.
   - The inline `home-manager.users.agent = {...}` block (138-231, ~94 lines) belongs in a new **`modules/devbox/home.nix`**, matching this repo's own split convention used by the modules it imports (`../direnv/home.nix`, `../pi-coding-agent/home.nix`, both referenced at 145-146).
   Everything else (users/nix/paseo/tailscale/tmpfiles) is coherent as one container's system policy.
3. **Comments.** 141/345 (41%). Bulk is category-2 keeps (vendor quirks / load-bearing constraints), e.g.: pi resource-loader `--append-system-prompt` slot fight (18-28), EROFS copy-not-link mechanics for claude settings (199-214), paseo's `resolveAuthConfig` fallback-to-unauthenticated behavior justifying the ExecStartPre check (276-293) — all KEEP-IN-PLACE, none re-derivable from a man page in under 10 minutes. One CUT: 222-230 ("Nothing else of claude's is seeded...") restates the EROFS/plugin-state reasoning already given at 64-75 and 199-214 — redundant, drop. One CUT: 312-313 duplicates the file's own header (line 2) and nixos.nix's header.
4. **Idiom.** Confirmed G1 hit from R4: line 53 `real = "${piWrapped}/bin/pi";` hand-built, in the same file as line 45's `lib.getExe pkgs.claude-code`. Caveat verified: `piWrapped` is a `symlinkJoin` named `"pi-wrapped"` (33-34) with no `meta.mainProgram`, so `lib.getExe piWrapped` today would resolve to `bin/pi-wrapped`, which doesn't exist — converging requires first adding `meta.mainProgram = "pi";` to the derivation. Reference for that addition already in-repo: `modules/photoform/package.nix:38`, `modules/encode_queue/package.nix:18`. Clears G3 once mainProgram is added (shorter, matches the file's own line-45 idiom).
5. **Namespace.** Declares no options (consumes `tailnetHostname`/`gitIdentity`/`signCommits` passed in from plugins.nix).
6. **Confidence:** high on responsibility split and the getExe finding; medium on which EROFS-comment cluster is "the" canonical one to keep vs. cut (all three are individually defensible in isolation).

#### modules/devbox/nixos.nix

1. **Purpose.** Declares `mine.system.devboxes.<name>` (the option interface) and assembles each into a `containers.<name>` using container.nix.
2. **Does.** Option schema (githubTokenFile, paseoPasswordFile, tailnetHostname, signingKeyFile, host/localAddress, gitIdentity) · assertions (FQDN hostname, 12-char name limit, unique addresses) · NAT/tmpfiles/bindMounts wiring · container assembly calling container.nix. **Verdict: coherent** — this is the options+wiring half of the same job container.nix is the implementation half of (B6's options/config split, already correctly done across these two files).
3. **Comments.** 35/271 (13%) — below the smell threshold. Nearly all are per-option justification of a non-obvious constraint (e.g. 68-77 on why `mode=0440`/`group=users` instead of sops-nix's default, 183-186 on the 15-char veth limit) — KEEP, all clear the "can't re-derive in 10 minutes" test. None flagged as A1-A5.
4. **Idiom.** None found; `mapAttrs`/`mapAttrsToList` usage is standard, no hand-built `${pkg}/bin/x`, no deprecated types.
5. **Namespace.** `mine.system.devboxes.*` — coherent; this is host-level infrastructure (containers), not user-facing, matches predicted `mine.system.*`. No misses.
6. **Confidence:** high.

#### modules/devbox/plugins.nix

1. **Purpose.** The list of pi npm plugin specs seeded into the container (membership only, no versions).
2. **Does.** One `piPackages` list assignment. **Verdict: table** (a two-entry list) wearing a large runbook.
3. **Comments.** 64/70 (91%). Split:
   - **KEEP-IN-PLACE:** 1-6 (no-versions design constraint — matches this project's own memory note on membership-vs-versions semantics, load-bearing on why the list has no version strings) and 8-14 (the `pi update --extensions` / pin-a-version escalation commands — genuine operational knowledge, not in any man page).
   - **RELOCATE:** 16-44 (the 29-line "REMOVING ONE, AND CLEANING UP AFTER IT" runbook — state-file paths, `pi remove` steps, the superpowers→subagents `subagent`-tool-name collision story). This is exactly rubric A5's "prose that explains a design rather than a line" — move to a dated runbook doc (e.g. `docs/devbox/pi-plugin-removal.md`), leave a one-line pointer comment here.
   - **RELOCATE (trim + cut duplication):** 46-50 restates the file's own header (1-6) almost verbatim — cut the restatement, keep only the cross-reference to `pi-coding-agent/settings.nix` (the one fact not already stated). 52-62 (pi-subagents vs. pi-superagents-fork vs. @gotgenes/pi-subagents justification) already cites `docs/superpowers/specs/2026-08-31-nested-orchestrator-plan.md` — since the full justification lives in that spec doc, trim this to a one-line pointer to it rather than re-explaining the WorkflowMode/allowNestedSubagents reasoning here.
   - **CUT:** 64-65 ("Same author as pi-web-access...") — trivia justifying a choice nobody will challenge, A3.
4. **Idiom.** None (no options declared, no hand-built paths).
5. **Namespace.** N/A — no options declared in this file (the option surface lives in nixos.nix).
6. **Confidence:** high on the KEEP/CUT calls; medium on the exact relocation target for the runbook (a plausible doc path is suggested, not verified against existing `docs/` structure).

#### Cross-file notes

- **Idiom summary:** one G1 instance in this batch (container.nix:53 vs :45, already flagged by R4); resolving it is gated on adding `meta.mainProgram` to `piWrapped`, referencing the pattern at `modules/photoform/package.nix:38` / `modules/encode_queue/package.nix:18`. No new idiom findings beyond R4's list.
- **Namespace summary:** no incoherence in this batch; `mine.system.devboxes.*` (nixos.nix) is the only option surface and reads correctly as system-level.
- **Verdict tally this batch:** coherent x2 (agents.nix, nixos.nix), overloaded x1 (container.nix, 2 named destinations), table x1 (plugins.nix).

---

### Ledger batch 04 — modules/pi-coding-agent, modules/system, modules/theme (10 files)

#### modules/pi-coding-agent/extra-packages.nix
1. **Purpose**: list packages `pi` plugins need on PATH regardless of project devShell.
2. **Does**: one `pkgs: [...]` list (nodejs, bun) — single entry, **table** (trivially, at 2 rows).
3. **Comments**: 1 header line, states why the list exists rather than restating `[ nodejs bun ]` — earns its place (KEEP).
4. **Idiom**: none.
5. **Namespace**: declares no options. n/a.
6. **Confidence**: high.

#### modules/pi-coding-agent/home.nix
1. **Purpose**: wire the `pi` coding agent into a user's home-manager profile with its writable state seeded correctly.
2. **Does**: declares `mine.user.pi-coding-agent.enable`; seeds `web-search.json`, `AGENTS.md` (store symlink, read-only by design), `settings.json` and `LESSONS.md` (both copied via `home.activation`, writable because pi/the harness rewrites them); sets `programs.pi-coding-agent.settings = {}` to opt the upstream module out of its own (symlinking) write. Every entry is a facet of "get pi's on-disk state right at build vs. leave the live-write paths alone" — **coherent**.
3. **Comments**: ~45 of 97 lines. All clear the KEEP-operational or KEEP-load-bearing bar individually (checkLinkTargets cascade risk at 45-49, EROFS-swallowed-silently at 70-76, `settings={}` opt-out semantics at 88-92, imageBudget single-source-of-truth at 51-54) — none are A1/A2/A3 filler. Two clusters (36-49 and 59-62) both explain the same AGENTS.md-vs-LESSONS.md split from slightly different angles — worth merging into one comment, not cutting either. Verdict: KEEP-IN-PLACE for all, but consolidate the split-explanation into a single block.
4. **Idiom**: none — no hand-built `${pkg}/bin` paths, no freeform-config opportunity not already used.
5. **Namespace**: `mine.user.pi-coding-agent.enable` — predictable as `mine.user.*` (home-manager program, per-user agent state). No misses.
6. **Confidence**: high.

#### modules/pi-coding-agent/settings.nix
1. **Purpose**: build the data (`settings`, `models`, `webSearch`, `imageBudget`) that seeds pi's config, sourced from `local-llm/models.nix` and `devbox/plugins.nix` so nothing is hand-duplicated.
2. **Does**: `mkModel`/`mkAlias`/`entriesFor` project the LLM catalog into pi's model-list shape; `inputsOf` derives the vision-capability flag; `settings` sets theme/model/npmCommand/packages/subagents; `models.providers` sets the OpenAI-compat provider block (thinking-kwargs, budget-token workaround); `webSearch` configures the keyless-provider fan-out. All facets of "one data file pi's settings.json and models.json get built from" — **coherent**, not overloaded (it's plumbing + policy for one consumer, not two).
3. **Comments**: ~110 of 218 lines (per rubric A this is the file the ~30% smell-threshold flags). Three clusters are paragraph-length design essays, not adjacent facts:
   - Lines 10-29 (`inputsOf` vision-gating rationale, ~18 lines): cites `openai-completions.js:1021`/`:70` line-specific upstream behavior — genuinely hard to re-derive, but it's a paragraph explaining a *design*, textbook A5. **RELOCATE** — one line in-code ("derived from `vision` block so prompt and enforcement can't drift; see doc for the tool-vs-attach asymmetry"), rest to a doc (this exact content already lives, per user's own memory index, as a standalone `pi-vision-propagation-gap` note — the in-code copy is now a duplicate of a doc that exists elsewhere).
   - Lines 95-125 (`subagents` block, ~30 lines): an essay on `resolveEffectiveSubagentModel` precedence, `modelSource.type`, and why no `defaultModel`/`defaultThinking` is set, guarding a 2-line config value (`maxThinking = "xhigh"`). Clears the "hard to re-derive" bar (cites upstream resolution order) but is a design doc wearing a `.nix` extension. **RELOCATE** to a doc on pi-subagents routing; leave a one-line pointer plus the maxThinking-is-a-ceiling fact in place.
   - Lines 179-205 (`webSearch.provider` rationale, ~25 lines): mixes A2 history ("This was pinned to exa alone, whose keyless endpoint is the standing... failure") with A5 design prose (auto vs. all semantics) and a how-to for a future maintainer. **RELOCATE**; keep the one load-bearing fact ("explicit list needed — `auto`/`all` both collapse to exa alone with no keys set") adjacent to `provider = [...]`.
   Non-essay comments (lines 74-75, 83-86, 137-142, 152-159, 166-170, 213-215) are short, cite specific vendor facts or bug numbers (`vllm#44676`), and individually clear KEEP — these are the rubric's own worked example of a good comment.
4. **Idiom**: none beyond R4's existing list — no hand-built `${pkg}/bin` paths in this file.
5. **Namespace**: declares no options directly (feeds `home.nix`'s `mine.user.pi-coding-agent`). n/a.
6. **Confidence**: medium-high on the comment triage (the relocate targets are a judgment call, not a rule); could not verify whether the vision-gating content actually duplicates a docs/ file or only a memory note — flagged as "check before cutting," not asserted as fact.

#### modules/system/darwin.nix
1. **Purpose**: shared base config applied to every darwin host.
2. **Does**: sets `system.stateVersion`, `system.configurationRevision` (from `inputs.self.rev`), nix experimental-features/gc/optimise, a nerd-font package, and `programs.fish.enable`. Small, same-kind system defaults — **table**.
3. **Comments**: 1 (file header, mild A1 but harmless). **Finding**: line 5, `system.configurationRevision = inputs.self.rev or inputs.self.dirtyRev or null;`, has **no comment**, and per this plan's own build-invariant work this is load-bearing: it makes the darwin toplevel `drvPath` a function of the commit hash, which broke the plan's build-invariant check until worked around. This is exactly rubric A's "load-bearing constraint on nearby code" case and it's currently silent — an absent comment that should exist, distinct from the 4 comment-count categories (this is a *missing* KEEP, not an extra CUT).
4. **Idiom**: none new.
5. **Namespace**: no `mine.*` options declared here (raw NixOS/darwin option names only). n/a — nothing to predict.
6. **Confidence**: high on the finding; the fix (drop it / gate it / accept the drvPath instability) is out of scope for a read-only walk.

#### modules/system/nixos.nix
1. **Purpose**: declare and apply per-host system policy under `mine.system.*` (hostname, networking interface, boot mode, upgrade/cache toggles).
2. **Does**: `options.mine.system` (hostName, externalInterface, renderGroupGid, wheelNeedsPassword, autoUpgrade.enable, privateCache.enable, boot.{mode,partitionUuid}); `config` sets base nix/networking/time/sudo policy unconditionally, then `mkIf`-gated blocks for autoUpgrade (flake ref + reboot window), privateCache (sops secrets/templates for a B2 substituter, tmpfiles for root's AWS profile), LUKS device mapping, and bootloader choice. Every option is genuinely machine/system-level — **coherent**, arguably a **table** of independent per-host toggles under one `mine.system` interface (B1: facets of "system-level policy this host turns on").
3. **Comments**: ~10 of 177 lines. `boot.mode` description (49-52) is a legitimate option doc (not a code comment, exempt from rubric A). Line 65 ("No assertion needed — the enum guarantees only one bootloader") is A3, minor, low priority to cut. Lines 94-96 (`autoUpgrade.flake` points at `verified`, not `main`), 118-121 (why creds must exist in daemon + autoUpgrade unit + root profile), 153-156 (AWS chain profile-file fallback, "replaces any existing root AWS creds") are all short, operational, hard-to-rederive-from-the-code-alone facts — KEEP, all of them.
4. **Idiom**: none beyond R4's list; no hand-built `${pkg}/bin` paths, no freeform-config opportunity.
5. **Namespace**: every option here (`hostName`, `externalInterface`, `renderGroupGid`, `wheelNeedsPassword`, `autoUpgrade`, `privateCache`, `boot.*`) is machine/system policy a reader would correctly predict as `mine.system.*`. **No misses** — this file does not corroborate FINDINGS.md's suspicion that `mine.system.*` holds non-system-ish knobs; that suspicion (printing, devboxes, teamspeak-client) points at other files outside this batch, not this one.
6. **Confidence**: high.

#### modules/theme/constants.nix
1. **Purpose**: the raw Catppuccin-mocha color/font/cursor/opacity data table theme consumers read from.
2. **Does**: one attrset — colors (base16 + Catppuccin extras), fonts, cursor, opacity. Pure data, same-kind entries — **table**.
3. **Comments**: header (1 line) states a real deviation from upstream (base01/03/04 differ) — KEEP, hard to recover otherwise. Per-color trailing comments (`# red`, `# comments, invisibles`, etc.) are role annotations the hex itself can't state — acceptable table annotation, not restatement of code, not counted against A1.
4. **Idiom**: none.
5. **Namespace**: declares no options (plain data file, `import`ed by `shared.nix`). n/a.
6. **Confidence**: high.

#### modules/theme/darwin.nix
1. **Purpose**: plug the `mine.system.theme` option/constants interface into the darwin module aggregator.
2. **Does**: `{ imports = [ ./shared.nix ]; }` only — no darwin-specific application. Verdict **coherent**: darwin has no NixOS-only sinks this module writes to (`fonts.packages`/`fontconfig.defaultFonts`/`programs.dconf`/system `qt.*` are Linux-desktop options with no darwin equivalent), so the file's job really is just "make the option and the unconditional `themeConstants` module-arg exist on darwin too" — confirmed by `hosts/mac/default.nix:31` setting `theme.fontSizes.terminal` without ever setting `theme.enable`, and that value still reaching `alacritty/home.nix` because `shared.nix`'s `home-manager.sharedModules` push of `themeConstants` is unconditional, not gated on `cfg.enable`. Not vestigial, just thin by design.
3. **Comments**: none.
4. **Idiom**: none.
5. **Namespace**: n/a, declares no options of its own.
6. **Confidence**: medium — confirmed by reading `shared.nix` and grepping `themeConstants` consumers and `hosts/mac/default.nix`, not by building the darwin host.

#### modules/theme/home.nix
1. **Purpose**: apply the resolved theme constants to home-manager-managed desktop surfaces (cursor, gtk, qt, kvantum, dconf).
2. **Does**: `home.pointerCursor`, `gtk.*` (theme/icon/font), `xdg.configFile` for vendored gtk.css and Kvantum theme, `qt.*` (qt5ct/qt6ct settings), `dconf.settings` desktop interface. All facets of "apply the palette to every desktop toolkit this setup uses" — **coherent** (B1/B4 hybrid: same job, repeated per-toolkit).
3. **Comments**: ~9 of 89 lines, all short and operational — vendored-from-stylix provenance + manual-regen instructions (34-35, 69-70), why `recursive = true` is needed for the Kvantum dir takeover (73-75), and a note that a double space in `document-font-name` is intentional, preserved from the migrated-off stylix template (85) — all KEEP, all clear the "would you re-derive this in ten minutes" bar.
4. **Idiom**: none new; `xdg.configFile.*.text`/`.source` usage here matches the pattern already recorded NOTE-ONLY in R4 item 4 (fuzzel) — not re-flagging, same disposition (a freeform `programs.*.settings` swap isn't available for gtk.css/Kvantum the way it is for fuzzel, so this doesn't even meet R4's bar).
5. **Namespace**: no options declared (pure home-manager config module, imported via `theme/nixos.nix`'s `sharedModules`). n/a.
6. **Confidence**: high.

#### modules/theme/nixos.nix
1. **Purpose**: apply resolved theme constants to NixOS-level (system, not per-user) desktop plumbing and wire `theme/home.nix` in for every user.
2. **Does**: `mkIf cfg.enable` block sets `fonts.packages`/`fontconfig.defaultFonts`, `programs.dconf.enable`, system `qt.enable`/`platformTheme`, and appends `./home.nix` to `home-manager.sharedModules`. All facets of "the NixOS-specific half of turning theming on" — **coherent**.
3. **Comments**: none (all documentation lives in `shared.nix`'s option descriptions and the `home.nix` it wires in).
4. **Idiom**: none.
5. **Namespace**: reads `config.mine.system.theme` (declared in `shared.nix`), declares nothing new here. n/a for this file.
6. **Confidence**: high.

#### modules/theme/shared.nix
1. **Purpose**: declare the `mine.system.theme` option interface and resolve constants (defaults + host overrides) for both platforms to consume.
2. **Does**: `options.mine.system.theme` (`enable`, `fontSizes.*`, internal read-only `constants`); `config` merges `constants.nix` defaults with `cfg.fontSizes` and pushes the result as an unconditional `_module.args.themeConstants` home-manager shared-module arg. Two facets (interface + one resolved value), both "make theme constants available and overridable" — **coherent**, not a B6 options/config split violation since this is a small module, not a "large module."
3. **Comments**: 1 substantive block (44-52, ~9 lines) — justifies module-arg over `extraSpecialArgs` on a real, non-obvious eval-cost/type-forcing basis. This is a load-bearing design constraint on nearby code (rubric A's second KEEP test), not prose about a design in the abstract — KEEP, it's the right length for what it's protecting against (an easy, wrong "simplification" to `extraSpecialArgs`).
4. **Idiom**: none.
5. **Namespace**: `mine.system.theme.*` — predictable as `mine.system.*`? This is the one namespace question worth flagging in this batch: theming is visually a per-user/desktop-preference concern, which could read as `mine.user.*` at a glance. It's correctly under `mine.system` because the options it actually sets are NixOS system-scoped (`fontconfig.defaultFonts`, `programs.dconf.enable`, system `qt.*`) even though the *effect* (via `themeConstants`) reaches home-manager modules too — a reader predicting `mine.user.theme` would be wrong but not unreasonably so. **Not a miss**, but the closest thing to one in this batch; does not corroborate FINDINGS.md's `mine.system` complaint (that one is about printing/devbox/teamspeak-client, a different shape of problem — options that have nothing to do with the *machine* at all, not options whose *effect* is visually user-facing).
6. **Confidence**: high on the mechanics, medium on the namespace call (it's a judgment about reader expectation, not a rule violation).

#### Idiom summary (cross-file)
No new G1/G2 idiom hits in this batch beyond what R4 already lists. The one near-miss (theme/home.nix's hand-written gtk.css/Kvantum text files) was checked against R4 item 4's fuzzel finding and doesn't clear G3 — no freeform-settings replacement exists for gtk.css/Kvantum, so it's not even a candidate, not just deprioritized.

#### Namespace summary (cross-file, GATE 2 input)
This batch's `mine.system.*` usage (system/nixos.nix, theme/shared.nix) is coherent — every option is genuinely machine-level or sets real NixOS system-scoped config. FINDINGS.md's prediction that `mine.system.*` holds non-system-ish knobs is **not corroborated by this batch**; that problem, if real, lives in files outside modules/system and modules/theme (printing, devbox, teamspeak-client per FINDINGS.md — none of which are in this batch). The `mine.user.pi-coding-agent.*` namespace is correctly used (home-manager program). The one soft call is `mine.system.theme` reading, at a glance, like it could be `mine.user.theme` given its visually-user-facing effect — recorded as a documented judgment call, not a rename candidate, since the options it actually declares are system-scoped.

#### Batch confidence
High on structure/comments/namespace across all 10 files. Medium on the settings.nix RELOCATE-vs-KEEP calls (subjective) and on whether the vision-gating comment duplicates an existing doc (not independently verified against docs/, only against the user's own memory index).

---

### Ledger batch 05 — dns-server, immich-server, stalwart-server (3 files)

#### modules/dns-server/nixos.nix (250 lines)
1. **Purpose**: run AdGuard Home + Unbound as a NixOS container providing LAN DNS.
2. **Does**: declares `enable`/`lanPort`/`webPort` options; opens host firewall ports + NAT forwards to the container (facet of "expose this container's ports"); registers a `mine.backups` path for AdGuardHome's mutable state (facet of "this data must survive"); creates two host state dirs via activation script; defines the `containers.dns` NixOS container itself (unbound + adguardhome config, tailscale, container-local firewall, hardened systemd sandboxing). Every entry is "stand this container up and make it reachable/durable" — one job, several facets. **Coherent**.
3. **Comments**: 1 total, at lines 67-70, justifying `mutableSettings=true` and the backup-while-running tradeoff — clears the "operational knowledge you can't get back in 10 min" bar, KEEP-IN-PLACE (it's directly load-bearing on the adjacent `mine.backups` block). Header block (lines 1-10) is bring-up runbook prose (A5 by nature — a paragraph explaining a workflow) but every service module in this batch carries the same shape (see stalwart/immich); treating it as a per-module "how to operationally reach this thing" doc-comment rather than code commentary. Borderline A5, not flagged as CUT here since it's operational and short; note for T13/doc-consolidation if a runbook doc is ever created.
4. **Idiom**: none beyond R4's existing list — no hand-built `${pkg}/bin/`, no dotted-vs-nested sops shape (no secrets here at all), no freeform-config opportunity found.
5. **Namespace**: `mine.system.dns-server.{enable,lanPort,webPort}` — all predictable `mine.system.*` (host-level service). No misses.
6. **Confidence**: high. B6 (options/config split): **not applicable/moot at this size** — the file already separates `options.mine.system.dns-server` from `config = lib.mkIf cfg.enable {...}` as two top-level blocks; there's no interleaving to flag.

#### modules/immich-server/nixos.nix (223 lines)
1. **Purpose**: run Immich as a NixOS container with NAS-backed storage and GPU transcoding.
2. **Does**: declares one `enable` option; asserts three prerequisite globals (render GID, NAS share GIDs) exist before enabling (facet of "fail loudly if my inputs are missing"); turns on two `mine.system.nas.shares` (homes, immich) it depends on; configures host `hardware.graphics` + a `render` group GID (needed for the container's bind-mounted `/dev/dri`); NAT for the container's egress; a `mine.backups` entry scoped to just the DB-dump subdir (photo blobs excluded by design, per its comment); host dirs via activation script; the `containers.immich` definition itself (bind mounts to NAS shares, immich service config, tailscale, hardened systemd). All of it is "make Immich work with GPU accel against the NAS" — one coherent job across many facets. **Coherent**. (Note: enabling sibling NAS-share options from here, same as photoform/other consumers do for their own dependencies elsewhere in the repo — not a foreign responsibility, it's the established cross-module dependency-activation pattern.)
3. **Comments**: 5 non-trivial. Lines 70-74 (immich DB backup rationale — NAS unmanaged, blobs excluded by design) is real operational knowledge, KEEP-IN-PLACE. Lines 92-93, 138, 143, 157, 161, 182, 189 are short restatement/A1-style (`# tun is needed for tailscale network`, `# renderD128 for hardware acceleration`, `# for hardware acceleration` above `users.groups.render.gid`, `# container level gids for nfs mounts`, `# needed to get the dns for https nameserver`, `# allows connection from other tailscale devices`) — each restates the adjacent line and would be obvious from reading the option name; candidates for CUT (A1), ~7 instances.
4. **Idiom**: none beyond R4's existing list.
5. **Namespace**: `mine.system.immich-server.enable` — predictable `mine.system.*`. No misses.
6. **Confidence**: high. B6: options block (lines 23-25) and config block (27-222) are already cleanly separated at the top level; nothing to flag.

#### modules/stalwart-server/nixos.nix (295 lines)
1. **Purpose**: run Stalwart mail as a NixOS container with only boot-critical config pinned locally.
2. **Does**: declares `enable` + `adminPasswordFile` options; host state dirs via activation script; host firewall ports for mail (25/465/993) plus a conditional 443 (only when caddy isn't claiming it — facet of "be reachable however this host's edge is configured"); NAT forwards mirroring those same ports/condition; a `mine.backups` entry for the DB state dir with `stopContainers` (facet of "this data must survive, consistently"); a conditional `mine.system.caddy.routes.mail` TCP-passthrough registration (same cross-module dependency-declaration pattern immich/photoform use — not foreign, it's how this repo's caddy module is meant to be driven by consumers); the `containers.stalwart` definition (bind mounts including the sops-provided admin-password file, stalwart service settings restricted to `local-keys`, tailscale, container firewall, hardened systemd). Every entry serves "run Stalwart, reachable on both raw ports and the caddy edge, durably". **Coherent** — the caddy/firewall/NAT triad is the same "make this container reachable under either topology" job, not three separate responsibilities; it doesn't own caddy's routing logic, only declares one route into it, matching the repo-wide pattern (see `modules/photoform/nixos.nix:62`).
3. **Comments**: heaviest comment load of the batch — 295 lines with a ~20-line header runbook (1-23) plus ~15 inline comments. Per-cluster judgment (rubric A + the live cert/caddy-l4 history called out for this file):
   - Lines 1-23 (bring-up runbook: container login, tailscale serve port choice rationale, first-login UI walkthrough): operational knowledge not recoverable from code (the `--https=8443` collision-avoidance reasoning especially). RELOCATE → a `docs/` runbook (rubric C5: docs live under `docs/`, not embedded as a 23-line file-header) rather than CUT; too long/prose-heavy for A5's "needs a paragraph → needs a doc" test, but too operationally load-bearing to delete.
   - Lines 66-69 (NAT block, "when caddy edge owns 443 ... passthrough ... unconditional forwards"): direct history of the merged/reverted/restored caddy-l4 passthrough (memory: `stalwart-cert-after-caddy-edge`). This is a load-bearing constraint on the adjacent conditional forward logic, not just history — KEEP-IN-PLACE, it explains *why* the mail ports stay unconditional while 443 is conditional, which a reader would otherwise have to reverse-engineer from git log.
   - Lines 103-108 (caddy route comment: TLS-ALPN-01 vs DNS-01, why raw TCP passthrough is required): same category — a load-bearing constraint on the `routes.mail` block directly below it. KEEP-IN-PLACE (adjacent, specific, explains a non-obvious choice a future edit could silently break).
   - Lines 171-177, 229-231, 244-247, 253-255 (`local-keys` rationale, store-role rationale, fallback-admin rationale, "NOTE: ACME/etc intentionally NOT set here"): these justify *why the file stops where it does* — genuinely load-bearing for a config style (minimal-local-keys) that isn't self-evident from the keys list alone; borderline A3/A5 but each is short (2-4 lines) and adjacent to the exact settings block it explains. KEEP-IN-PLACE as a set; if trimmed, keep at minimum the "why NOT set here" note since that's the one a future editor is most likely to violate by accident.
   - Lines 130-132 ("Persistent state -- MUST be ... to match the module's StateDirectory"): load-bearing operational constraint (wrong path silently breaks state persistence). KEEP-IN-PLACE.
   - Lines 92-93 ("tun for Tailscale"), 192-195 ("bootstrap hostname..."), 221 ("Admin UI on localhost only..."): short, mostly restate adjacent code (A1-ish) though the bootstrap-hostname one (192-195) borders on real rationale. Lower priority; candidate CUT for the tun/admin-UI ones, KEEP for the bootstrap-hostname one (explains *why* a real domain is hardcoded here despite the "DB-managed" policy).
4. **Idiom**: none beyond R4's existing list. `adminPasswordFile` (line 36) takes a raw `types.path` rather than being declared as a `sops.secrets.*` reference directly in this module — but that's correct: the file *consumes* a host-level sops secret path via an option, it doesn't declare the secret itself, so F2 (uniform secret-declaration shape lives at the host level) is respected, not violated.
5. **Namespace**: `mine.system.stalwart-server.{enable,adminPasswordFile}` — predictable `mine.system.*`. No misses.
6. **Confidence**: high on responsibility/namespace. B6: options (34-45) and config (47-294) are already cleanly separated at the top level — nothing to flag. Medium confidence on the comment RELOCATE destination (no `docs/` runbook directory currently exists for per-service bring-up steps in this repo as far as this batch's file-scope review can confirm — that's a T13-level call, not this file's).

#### Cross-cutting note (F2, all three files)
None of the three files declares raw secrets inline in a divergent shape — `stalwart-server` is the only one with a secret at all, and it's consumed via an option (`adminPasswordFile`) pointing at a host-declared `sops.secrets.*`, consistent with how the rest of the repo keeps secret *declaration* at the host level and secret *consumption* in the service module. No F2 violation found in this batch.

---

### Ledger batch 06

Files: `modules/caddy/nixos.nix`, `modules/caddy/package.nix`,
`modules/filesystems/default.nix`, `modules/filesystems/nas.nix`,
`modules/firefox/darwin.nix`, `modules/firefox/home.nix`,
`modules/photoform/nixos.nix`, `modules/photoform/package.nix`.

---

#### modules/caddy/nixos.nix

1. **Purpose**: declare and run the host's SNI-routing Caddy edge (owns ports 80/443).
2. **Does**: options (`enable`, `acmeEmail`, `routes` registry) · uniqueness/non-empty assertions on routes · firewall ports · backup path for `/var/lib/caddy` · `services.caddy` with layer4 globalConfig + per-route virtualHosts. All facets of one job. **Verdict: coherent.**
3. **Comments** (rubric A):
   - Lines 1-20 (file header): design-doc prose on the routing model, port 80 challenge lane, and the 127.0.0.1-address regression — mostly A5 (explains a design, not a line), with an A2 history fragment (the Stalwart auto-ban incident). Per this batch's calibration this is **RELOCATE** (to a caddy-edge operations doc under `docs/`), not CUT — it's live operational context for the caddy-l4 passthrough, not dead history.
   - Lines 29-30 (`httpsPort`), 98-101 (assertion rationale), 112-114 (backup rationale), 121 (package pointer), 133-136 (why `tcp` routes get no vhost): all short, load-bearing, adjacent to the code they explain. **KEEP-IN-PLACE**.
   - Lines 32-37 (`routeBlock`, caddy-fmt-owns-whitespace + test-pinning warning): load-bearing constraint on nearby code (a reindent breaks `tests/photoform.nix`). **KEEP-IN-PLACE**.
   - Net: 1 cluster RELOCATE, 6 clusters KEEP-IN-PLACE, 0 CUT.
4. **Idiom**: none — no hand-built `${pkg}/bin`, uses `pkgs.callPackage ./package.nix { }` correctly, no R4 hits.
5. **Namespace**: `mine.system.caddy.*` — reader predicts `system` (host networking/ports); matches.
6. **Confidence**: high. The header-comment RELOCATE call assumes a destination doc doesn't yet exist for this edge — didn't find one to confirm the target path, only that `docs/` is the right tier.

#### modules/caddy/package.nix

1. **Purpose**: build Caddy with the `caddy-l4` plugin compiled in.
2. **Does**: `caddy.withPlugins` + `overrideAttrs` to set `passthru.cache = true`. Just a derivation. **Verdict: coherent** — matches the B7 reference pattern; no drift into module-side concerns.
3. **Comments**: header (lines 1-6, Go-toolchain-bump-invalidates-hash) and lines 13-14 (binary-cache opt-in) are both non-obvious operational facts a reader can't get from the man page. **KEEP-IN-PLACE**, 0 CUT candidates.
4. **Idiom**: none.
5. **Namespace**: n/a — no options declared.
6. **Confidence**: high.

#### modules/filesystems/default.nix

1. **Purpose**: aggregate the filesystems module's files for import.
2. **Does**: `imports = [ ./nas.nix ]`, nothing else. **Verdict: coherent** (trivial single-entry aggregator, matches this repo's per-directory `default.nix` convention).
3. **Comments**: none.
4. **Idiom**: none.
5. **Namespace**: n/a.
6. **Confidence**: high. Split vs. `nas.nix` is coherent — `default.nix` is pure aggregation, all actual logic lives in `nas.nix`; nothing generic-to-filesystems-but-not-NAS exists to justify content here.

#### modules/filesystems/nas.nix

1. **Purpose**: mount NAS shares and grant per-user read/write access to them.
2. **Does**: `mine.system.nas.{host,shares}` options (submodule per share incl. hardcoded gids for `media`/`homes`/`immich`) · `mine.users.<name>.nasAccess` extension option · nfs kernel/rpcbind config · group creation from gids · per-user `extraGroups` derivation · two assertion families (access references an enabled share; access level has a matching gid) · `fileSystems` generation · a home-manager shared-module symlink into `~/nas`. All facets of one job (mount + gate access to NAS shares); not a table of many same-kind shares (only 3 hardcoded), not overloaded — group/mount/assertion/symlink logic all exist because of the access-control facet. **Verdict: coherent**, not a table, not overloaded — the FINDINGS.md flag looks driven by line count, which rubric B4 explicitly rejects as the test.
3. **Comments**: zero `#` comments in the file (option `description` strings aren't rubric-A comments). Nothing to cut.
4. **Idiom**: none — no R4 hits, no hand-built paths.
5. **Namespace**: `mine.system.nas.*` predicts/matches `system`. `mine.users.<name>.nasAccess` is declared under the separate `mine.users` per-account registry namespace (see `modules/users/nixos.nix:17`), not `mine.user.*` (the current-home-manager-user namespace `firefox/home.nix` uses). Both namespaces are real and serve different jobs, but a reader unfamiliar with the split could easily predict `mine.user.nasAccess` here — worth confirming this plural/singular split is documented before GATE 2 treats it as coherent by default.
6. **Confidence**: high on structure/comments; medium on whether the `mine.users` vs `mine.user` split is intentional-and-documented or accidental — flagging for the namespace summary rather than judging it myself.

#### modules/firefox/darwin.nix

1. **Purpose**: install Firefox on darwin via homebrew cask (unmanaged config).
2. **Does**: one option (`mine.system.firefox.enable`), one cask. **Verdict: coherent.**
3. **Comments**: line 1, "Firefox is unmanaged on darwin — homebrew cask only, configured manually" — short, load-bearing (tells the reader not to look for prefs here). **KEEP-IN-PLACE.**
4. **Idiom**: none.
5. **Namespace**: `mine.system.firefox.enable` predicts/matches `system` (host-level package install, no user profile config here).
6. **Confidence**: high.

#### modules/firefox/home.nix

1. **Purpose**: configure Firefox (fonts, reader colors, privacy/telemetry policy) for the user.
2. **Does**: one `programs.firefox` block: profile `settings` (fonts/reader-theme prefs + a few user.js-only prefs) and `policies` (telemetry/tracking/extension/preference locks). Every entry is the same kind of thing — a locked preference or forced value — driven by one job (privacy-hardened Firefox). **Verdict: table** (rubric B4); 206 lines is not a defect here, and nothing in it belongs to a different file. Not overloaded — resisting the temptation to call it that from length alone, per this batch's calibration.
3. **Comments**: ~8 `#` comments, nearly all justification a reader can't recover quickly: px/pt font conversion (line 10), why some prefs live in user.js instead of policy (34-35), what "strict" ETP covers so nearby prefs aren't read as redundant (55-58), why login/autofill policies exist (67), PPA-default-on-since-FF128 fact (184), Safe-Browsing-vs-download-ping distinction (189). **KEEP-IN-PLACE**, all of them. One weaker case: line 154 ("No speculative connections to sites that were never clicked") restates what the six prefs below it already say (A1-ish) — mild CUT candidate, low value either way.
4. **Idiom**: none.
5. **Namespace**: `mine.user.firefox.enable` predicts/matches `user`.
6. **Confidence**: high.

#### modules/photoform/nixos.nix

1. **Purpose**: run the PhotoForm booking container on this host, fronted by the caddy edge.
2. **Does**: options (`enable`, `sopsFile`) · reachability assertion (needs `mine.system.caddy`) · sops secrets · outbound NAT · host state dir · caddy route registration · backup config (stop-then-back-up) · the `containers.photoform` definition (bind mounts, systemd service w/ credential-file env vars, hardening, container-internal networking/firewall). All facets of standing up one container service. **Verdict: coherent.**
3. **Comments**: header (1-6) and all inline comments (33-34, 49-50, 70-71, 116, 125-126, 138-140) are operational/security rationale — why the assertion exists, why NAT is outbound-only, the stop-strategy for sqlite, why `_FILE` env vars over raw values, what re-owns the bind mount, systemd `LoadCredential` mechanics. All non-obvious, all short. **KEEP-IN-PLACE**, 0 CUT.
4. **Idiom**: none — `ExecStart = lib.getExe photoform` (line 137) already uses the repo's newest spelling (R4 item 1's reference pattern), so this file is itself a correct instance, not a divergent one. Sops secrets (42-47) use the dotted-path form (`foo.sopsFile = cfg.sopsFile`) uniformly across all four entries — this is the *older* shape R4 item 2 already flagged (majority/reference is the nested-attrset form); adding as a same-file-uniform instance, not a new finding, cites `modules/photoform/nixos.nix:42-47`.
5. **Namespace**: `mine.system.photoform.*` predicts/matches `system`.
6. **Confidence**: high.

#### modules/photoform/package.nix

1. **Purpose**: build the PhotoForm booking-app binary from its private GitHub repo.
2. **Does**: `rustPlatform.buildRustPackage` with private fetchFromGitHub source, `cargoHash`, a `postInstall` that copies in `production.toml`, `passthru.cache`/`configPath`. Just a derivation. **Verdict: coherent** — matches B7; no module-side logic leaked in.
3. **Comments**: `configPath` rationale (7-9), private-fetch netrc mechanism (19-21), `cargoHash`-not-`cargoLock` rationale (23-25), cache opt-in (32) — all non-obvious and short. **KEEP-IN-PLACE.** Line 27 ("cargo installs the binary and nothing else") is A1-ish restatement of the `postInstall` line below it — mild CUT candidate.
4. **Idiom**: none.
5. **Namespace**: n/a — no options declared.
6. **Confidence**: high.

---

#### Batch verdict tally
coherent: 6 (caddy/nixos.nix, caddy/package.nix, filesystems/default.nix, firefox/darwin.nix, photoform/nixos.nix, photoform/package.nix) · table: 1 (firefox/home.nix) · overloaded: 0 · coherent-not-table (long, judged explicitly against B4): 1 (filesystems/nas.nix).

#### Batch idiom summary (all G3/G4-cleared, none new beyond R4)
- Sops dotted-path form: `modules/photoform/nixos.nix:42-47` is another uniform instance of the older shape R4 item 2 already flagged (reference: nested-attrset, cited at `hosts/redtruck/default.nix`). No new G1 finding, just additional evidence for T8/rubric F2 to fold in.
- No G2/NOTE-ONLY hits in this batch; `getExe` at `photoform/nixos.nix:137` is a correct instance of the repo's current idiom, not a divergence.

#### Batch namespace summary
- All `mine.system.*` and `mine.user.*` declarations in this batch predict correctly (caddy, photoform, both firefox files).
- One real ambiguity for GATE 2: `modules/filesystems/nas.nix:80` declares `mine.users.<name>.nasAccess` under the plural `mine.users` per-account registry (`modules/users/nixos.nix:17`), a namespace distinct from the singular `mine.user.*` home-manager-profile namespace used elsewhere in this batch (firefox). Both exist for real, different reasons, but nothing in this batch's files documents the plural/singular split for a reader — worth GATE 2 confirming this is intentional-and-documented elsewhere rather than accidental drift.

---

### Ledger batch 07

Files: `modules/backups/nixos.nix`, `modules/jellybox/home.nix`,
`modules/jellybox/nixos.nix`, `modules/jellyfin-server/nixos.nix`,
`modules/teamspeak-server/nixos.nix`, `modules/terraria-server/nixos.nix`,
`modules/vikunja-server/nixos.nix`.

#### modules/backups/nixos.nix

1. **Purpose**: declare a host's B2 restic backup job that service modules register paths into.
2. **Does**: define `mine.backups.*` options (repo/creds/schedule/paths/stopContainers) — coherent; wire `services.restic.backups.host` from them — coherent; assert `paths != []` — coherent. Verdict: **coherent** (one job, options+wiring are facets of it).
3. **Comments**: ~25 comment lines/119 (~21%). Lines 16-22 (restore runbook) and 12-14 (1Password warning) and 102-104 (`|| true` rationale) are load-bearing operational knowledge — keep. Lines 1-4 lean A2/A3 (history of "generalizing the pattern proven by stalwart-server") — could trim to the constraint itself.
4. **Idiom**: none beyond R4's list; `pkgs.nixos-container` interpolated as `${pkgs.nixos-container}/bin/nixos-container` (line 106,109) is the same hand-built-path pattern R4 #1 already covers elsewhere — not re-cited per-instance here, folded into that existing finding.
5. **Namespace**: `mine.backups.*` (not `mine.system.backups.*`) — consistent with existing top-level precedents `mine.users`, `mine.allowedUnfree`; not a miss.
6. **Confidence**: high.

#### modules/jellybox/home.nix

1. **Purpose**: opt-in auto-launch of the Jellyfin client on login for the jellybox appliance user.
2. **Does**: declare `mine.user.jellybox.autoStart.enable`, enable fish, wire `loginShellInit` to exec gamescope+jellyfin-media-player on a bare VT. Verdict: **coherent**.
3. **Comments**: none.
4. **Idiom**: none.
5. **Namespace**: `mine.user.jellybox.autoStart.enable` — predictable as `mine.user.*` (login-shell/appliance-user behavior). OK.
6. **Confidence**: high.

#### modules/jellybox/nixos.nix

1. **Purpose**: turn a host into the Jellybox kiosk appliance (greetd autologin into the Jellyfin client).
2. **Does**: build a gamescope+jellyfin kiosk wrapper, wire greetd initial/default session, set lid-switch behavior for docked/AC use, enable gamescope, install the client package, add a `maintenance` specialisation that reverts greetd/lid behavior. Verdict: **coherent** (all facets of "make this box a kiosk appliance").
4. **Idiom**: uses `lib.getExe` already (lines 9, 11) — this is the newest-style spelling R4 cites as reference; no findings here.
5. **Namespace**: `mine.system.jellybox.enable` — predictable (system-wide appliance behavior: greetd, logind, packages). OK.
3. **Comments**: 2 comment lines. Line 26 ("Quit Jellyfin -> comes straight back") is load-bearing (explains intended UX). Lines 27-30 (swap-in snippet for a recoverable prompt) are useful operational knowledge — keep. Line 38 ("closing the lid shouldn't kill playback...") restates the three settings lines directly below it — A1, cut.
6. **Confidence**: high.

#### modules/jellyfin-server/nixos.nix

1. **Purpose**: run Jellyfin in a NixOS container with GPU passthrough and a NAS media mount.
2. **Does**: assert render/media GIDs are set, mount the NAS media share, enable host graphics + render group, open LAN/NAT access unconditionally, register with `mine.backups` (stop+raw-copy sqlite), build the container (tailscale, jellyfin, hardened systemd unit). Verdict: **coherent** (one container's worth of concerns), but see Idiom summary below — its firewall/NAT exposure choice is the oldest of four sibling patterns.
3. **Comments**: 7 A1 restatement comments — `# Enable the NAS media share as persistent` (37), `# for hardware acceleration` (51, dup at 137), `# tun is needed for tailscale network` (91), `# renderD128 for hardware acceleration` (92), `# persists the tailscale node` (121), `# container level gid for the media group and nfs mount` (134). Keep: header bring-up (1-5), the DynamicUser/sqlite-backup rationale (70-73), and the driver-passthrough rationale (116).
4. **Idiom**: none beyond what's cited in the cross-file section below.
5. **Namespace**: `mine.system.jellyfin-server.enable` — predictable. OK.
6. **Confidence**: high.

#### modules/teamspeak-server/nixos.nix

1. **Purpose**: run a TeamSpeak3 server in a NixOS container with optional tailnet and public access.
2. **Does**: declare `enable`/`tailscaleAccess`/`publicAccess` toggles, conditionally set up tailscale tun bind-mount and dirs, conditionally open public UDP/TCP ports, register sqlite identity file with `mine.backups`, build the container (tailscale, teamspeak3, hardened unit gated on the same toggles). Verdict: **coherent**.
3. **Comments**: header bring-up (1-7, keep — includes a non-obvious token-retrieval command) and the sqlite-identity backup rationale (32-34, keep). Four trailing `# Voice` / `# File Transfer` comments (41-42, 56, 61) restate the adjacent port number — A1, cut.
4. **Idiom**: none new.
5. **Namespace**: `mine.system.teamspeak-server.{enable,tailscaleAccess,publicAccess}` — predictable. OK.
6. **Confidence**: high.

#### modules/terraria-server/nixos.nix

1. **Purpose**: run a Terraria dedicated server in a NixOS container, reachable only over tailnet.
2. **Does**: declare `enable`/`port`/`password`/`maxPlayers`, set up NAT+dirs, build the container (terraria service pointed at the declared options, tailscale, no public firewall opening). Verdict: **coherent**.
3. **Comments**: only the header bring-up block (1-4) — keep. Cleanest file in the batch.
4. **Idiom**: none.
5. **Namespace**: `mine.system.terraria-server.*` — predictable. OK.
6. **Confidence**: high.

#### modules/vikunja-server/nixos.nix

1. **Purpose**: run Vikunja + its Postgres backend in a NixOS container with a host-surfaced nightly dump for backup.
2. **Does**: declare `enable`/`jwtSecretFile`, wire NAT+dirs, register the dump path with `mine.backups`, build the container (vikunja pointed at a unix-socket postgres, JWT secret via bind-mounted file + `environmentFiles`, a pg_dump oneshot+timer, tailscale, hardened unit). Verdict: **coherent** — the dump timer is a facet of "this container's backup story," not a foreign responsibility.
3. **Comments**: mostly load-bearing/keep (secret-sourcing note at 77, dump-surfacing contract at 82-84/130-133, TLS-termination rationale at 100, socket-auth rationale at 107, the operational reminder at 113). One A1 fail: `# tun is needed for tailscale network` (59, same phrase duplicated from jellyfin/teamspeak/terraria — see below).
4. **Idiom**: `jwtSecretFile` is a plain `lib.types.path` option filled by the host from `config.sops.secrets.vikunja-jwt-secret.path` (verified `hosts/paynefield/default.nix:55`) — this is the one file in the batch with a real secret, and its shape (host resolves the sops path, module takes a plain path option, bind-mounts it into the container) is the reference worth matching if another container module grows a secret.
5. **Namespace**: `mine.system.vikunja-server.{enable,jwtSecretFile}` — predictable. OK.
6. **Confidence**: high.

---

#### Idiom summary (cross-file, the point of this batch)

**1. Off-tailnet reachability: three spellings across four sibling `*-server` containers, no shared toggle.**
- `jellyfin-server/nixos.nix:55-62,152` (oldest, created 2026-03-03): LAN + NAT port-forward and the container's own `allowedTCPPorts` are **unconditional** — no way to run tailnet-only without editing the module.
- `teamspeak-server/nixos.nix:16-17,40-43,51-62,102-106` (2026-03-06): reachability is a first-class choice via two `mkEnableOption`s, `tailscaleAccess` and `publicAccess`, each independently gating dirs/bind-mounts/forwardPorts/firewall.
- `terraria-server/nixos.nix` and `vikunja-server/nixos.nix` (2026-05-02 / 2026-05-27, newest of the four): no public-access option at all — tailnet-only is baked in, `openFirewall = false` (terraria:83) / no `allowedTCPPorts` (vikunja), reachability is exclusively `trustedInterfaces = [ "tailscale0" ]`.
- Reading newest-as-reference (rubric G1): the trend is toward tailnet-only-by-default with no public toggle, which makes teamspeak's explicit `publicAccess`/`tailscaleAccess` pair the most deliberate spelling but jellyfin the outlier that never got an opt-out. If jellyfin's LAN/NAT exposure is still wanted, it should be a `publicAccess`-style option like teamspeak's, not an unconditional wire — currently a host cannot disable it without editing the module. Recording only; not chased here (G3 judgment on whether jellyfin genuinely needs LAN access is a product decision, not a spelling fix).

**2. Hardened systemd unit block: identical everywhere, so no drift — noted for completeness.**
`jellyfin-server/nixos.nix:163-182`, `teamspeak-server/nixos.nix:111-127`, `vikunja-server/nixos.nix:176-188` all hand-roll the same `ProtectHome`/`PrivateTmp`/`ProtectControlGroups`/`ProtectKernelTunables`/`NoNewPrivileges`/`RestrictAddressFamilies` block verbatim (also present outside this batch: `dns-server`, `photoform`, `stalwart-server`, `immich-server`). This is consistent, not drifted, so it is not a G1 finding; flagged only as a candidate for T13 (a shared `mkContainerHardening` helper would remove 7x duplication) — out of scope for an idiom finding since there is no existing replacement site to cite per G4.

**3. `# tun is needed for tailscale network` duplicated verbatim.**
`jellyfin-server/nixos.nix:91`, `terraria-server` (bind-mounts, uncommented there), `vikunja-server/nixos.nix:59` — same A1 restatement copy-pasted across the batch. Not an idiom/G1 finding (no functional pattern to converge on), just note under Comments per-file above.

#### Namespace summary

All 7 files in this batch use `mine.system.*` for host/container-level toggles and `mine.user.*` for the one login-shell option (`jellybox/home.nix`) — fully coherent, zero misses. `backups/nixos.nix`'s top-level `mine.backups.*` (rather than `mine.system.backups.*`) matches two other existing top-level precedents (`mine.users`, `mine.allowedUnfree`) elsewhere in the tree, so it reads as an established, if narrow, third category rather than incoherence — not a rename candidate from this batch alone.

---

### TW ledger — batch 08

Files: `_1password`, `alacritty`, `fish`, `fuzzel`, `niri`, `paseo-desktop`, `users` (14 files).

#### modules/_1password/darwin.nix
1. **Purpose**: install the 1Password app/CLI at system scope on darwin.
2. **Does**: unfree allowlist, homebrew cask, CLI package. All one job (system install). Verdict: **coherent**.
3. **Comments**: none.
4. **Idiom**: clean, no findings.
5. **Namespace**: `mine.system._1password.enable` — predictable (system-scope install). No miss.
6. **Confidence**: high.

#### modules/_1password/home.nix
1. **Purpose**: wire 1Password into the user session (extension, silent-start service, niri screen-capture rule).
2. **Does**: unfree allowlist; Firefox extension policy; systemd user service for silent start; niri window-rule contribution via `mine.user.niri.extraConfig`. Four entries, all "make 1Password behave correctly in this user's session" — same job, different mechanisms. Verdict: **coherent** (table-like: one per integration point).
3. **Comments**: 1 line at :30 is A1 restatement (`# makes a systemd service that runs 1password --silent on execution.` directly above code that does exactly that) — cut.
4. **Idiom**: `lib.getExe'` at :40 already matches house style (R4's reference pattern) — no finding.
5. **Namespace**: `mine.user._1password.enable`, `.silentStart.enable` — both predictable user-scope. No miss.
6. **Confidence**: high.

#### modules/_1password/nixos.nix
1. **Purpose**: enable 1Password's system-level NixOS integration (polkit, package, optional source overlay).
2. **Does**: unfree allowlist; `programs._1password`/`programs._1password-gui` enable + polkit owners derived from HM users; overlay option pinning a workaround tarball/hash. All system-scope 1Password wiring. Verdict: **coherent**.
3. **Comments**: :11 `# allowedUsers is the names of all users that have 1password enabled` restates the code beneath it (A1) — cut. :22 overlay comment `(workaround for upstream hash mismatch)` is inline in the mkEnableOption description, not a comment — fine, it's load-bearing context for why the option exists.
4. **Idiom**: none.
5. **Namespace**: `mine.system._1password.enable`, `.overlay.enable`, `.overlay.url`, `.overlay.hash` — all predictable system-scope. No miss.
6. **Confidence**: high.

#### modules/alacritty/home.nix
1. **Purpose**: render the Alacritty config (fonts, theme colors, window) from `themeConstants`, cross-platform.
2. **Does**: single `programs.alacritty.settings` block plus `TERMINAL` env var. One job. Verdict: **coherent**.
3. **Comments**: :104-109 is a 5-line justification for omitting `indexed_colors` — earns its place (load-bearing operational knowledge: explains a real gotcha that bit a real symptom, "pi's background rosewater"). Keep.
4. **Idiom**: none.
5. **Namespace**: `mine.user.alacritty.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/alacritty/linux.nix
1. **Purpose**: bind a niri launch key for Alacritty (Linux/niri-only, so split out of the cross-platform base).
2. **Does**: one `mine.user.niri.extraBinds` contribution, gated on both alacritty and niri being enabled. Verdict: **coherent**.
3. **Comments**: :1 file-header comment states why the split exists (load-bearing: explains the darwin-importability constraint) — keep, but it duplicates the finding logged once below (see platform-split note).
4. **Idiom**: `lib.getExe config.programs.alacritty.package` at :11 matches house style. No finding.
5. **Namespace**: no options declared (config-only), reads `mine.user.alacritty`/`mine.user.niri`. N/A.
6. **Confidence**: high.

#### modules/fish/home.nix
1. **Purpose**: configure fish shell for the user (interactive/login init, theme).
2. **Does**: theme file (`xdg.configFile`), `programs.fish` enable + init scripts. Two facets of one job (shell UX). Verdict: **coherent**.
3. **Comments**: :47,:52 `# Disable greeting` above `set fish_greeting` is A1 restatement, present twice — cut both.
4. **Idiom**: theme rendered as hand-written text (`xdg.configFile."fish/themes/..."`) — not flagged; no evidence home-manager's `programs.fish` exposes a structured theme option (checked: it doesn't), so this doesn't clear G4's "replacement already exists" bar.
5. **Namespace**: `mine.user.fish.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/fish/nixos.nix
1. **Purpose**: enable fish at system scope and make it the default shell.
2. **Does**: `programs.fish.enable`, `users.defaultUserShell`. One job (system shell provisioning). Verdict: **coherent**.
3. **Comments**: none.
4. **Idiom**: none.
5. **Namespace**: `mine.system.fish.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/fuzzel/home.nix
1. **Purpose**: configure the fuzzel launcher (theme/behavior) and its niri launch keybind.
2. **Does**: hand-built INI written to `xdg.configFile`; niri keybind contribution gated on niri being enabled. Two facets of one job (launcher setup). Verdict: **coherent**.
3. **Comments**: none.
4. **Idiom**: :58 hand-built INI vs `programs.fuzzel.settings` — **already recorded by R4 as NOTE-ONLY** (option-namespace reshuffle, fails G3 bar for this walk). Not re-flagged as actionable here, per instructions.
5. **Namespace**: `mine.user.fuzzel.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/niri/home.nix
1. **Purpose**: deploy the user-level niri config (base KDL, portal wiring, dynamic fragment aggregation points).
2. **Does**: forces 1Password silent-start on; xdg-desktop-portal config; a small package set (brightnessctl, wl-clipboard, nautilus, xwayland-satellite); writes base `config.kdl` + aggregates `extraConfig`/`extraBinds` from other modules. The 1Password line and the package list are two things that don't obviously follow from "niri config" by name — arguably desktop-session bootstrapping riding on the niri module because niri is the first thing enabled. Verdict: **table-ish/coherent** — these are all "things a niri session needs to function," which is one job (session bring-up), not overloaded; the `mine.user._1password.silentStart.enable = true` line is a one-off cross-module default that a reader wouldn't expect from the file name, but it's a single line, not a moved responsibility.
3. **Comments**: :16-19 and :25 are load-bearing (explain what `dynamic.kdl`/`binds.kdl` are for, not restating code) — keep, both earn their place.
4. **Idiom**: hand-written `config.kdl` (:47) vs home-manager's `wayland.windowManager.niri` module — **already recorded by R4 as explicitly rejected** (behavior change, not idiom swap). Not re-flagged.
5. **Namespace**: `mine.user.niri.enable`, `.extraConfig`, `.extraBinds` — predictable. No miss.
6. **Confidence**: medium — the 1Password default-on line (:29) is a judgment call on whether it belongs here vs in `_1password/home.nix`; noting but not promoting to overloaded since it's a single line and niri is the trigger condition, not the payload.

#### modules/niri/nixos.nix
1. **Purpose**: enable niri at system scope and push the per-user enable through home-manager.
2. **Does**: Wayland env var, `programs.niri.enable`, `home-manager.sharedModules` pushing `mine.user.niri.enable = true`, optional host-specific KDL file deployed to `/etc`. All system-level niri bring-up. Verdict: **coherent**.
3. **Comments**: :12-16 (hostConfig description) is load-bearing — explains the `/etc/niri/host.kdl` + `include optional=true` contract, not re-derivable quickly. Keep.
4. **Idiom**: none.
5. **Namespace**: `mine.system.niri.enable`, `.hostConfig` — predictable. No miss.
6. **Confidence**: high.

#### modules/paseo-desktop/darwin.nix
1. **Purpose**: install the Paseo desktop app on darwin via homebrew and enable its client-mode settings.
2. **Does**: homebrew cask; pushes `mine.user.paseo-desktop.enable` through home-manager. Two lines, one job (install + wire the consequence). Verdict: **coherent**.
3. **Comments**: :10 (`# The cask flag implies...`) is a short, load-bearing note explaining a non-obvious coupling — keep. :1-2 (file header, homebrew vs nix package rationale) is borderline A3 (justifying a choice) but it's the kind of vendor/build-process quirk ("darwin build runs electron-builder...") someone can't quickly re-derive — keep.
4. **Idiom**: none.
5. **Namespace**: `mine.system.paseo-desktop.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/paseo-desktop/home.nix
1. **Purpose**: install the Paseo desktop client (Linux) and seed its settings file to run in client-mode against a remote daemon.
2. **Does**: wraps the flake-input desktop package with a pinned `PASEO_ELECTRON_USER_DATA_DIR` (Linux only); builds a JSON settings seed; activation script installs the seed only if absent, else warns if the existing file disagrees. All in service of one outcome (client-mode desktop app), several mechanisms. Verdict: **coherent** (dense but B1: all facets of one job).
4. **Idiom**: none — the activation-script seed-if-absent pattern is bespoke but no simpler upstream equivalent found.
3. **Comments**: :13, :20-21, :38-39, :53-55 are all load-bearing (explain non-obvious Electron/upstream behavior a reader can't quickly re-derive: userData naming, worktree redirection, partial-document semantics, re-clobber risk). None cut. This file is the batch's best example of comments earning their keep.
5. **Namespace**: `mine.user.paseo-desktop.enable` — predictable. No miss.
6. **Confidence**: high.

#### modules/users/darwin.nix
1. **Purpose**: enable home-manager integration for darwin and bridge per-user unfree packages to system scope.
2. **Does**: imports the HM darwin module; sets `useGlobalPkgs`/`useUserPackages`/`extraSpecialArgs`; bridges `mine.allowedUnfree` from HM users up to system config. Two entries (HM wiring, unfree bridge) that both exist only because `useGlobalPkgs` forbids HM from writing `nixpkgs.config` directly — same root cause, one job. Verdict: **coherent**.
3. **Comments**: :13-15 is load-bearing (explains the `useGlobalPkgs` constraint that makes the bridge necessary, and cross-references the nixos.nix twin) — keep.
4. **Idiom**: none.
5. **Namespace**: no `mine.*` options declared here (config-only, reads `config.home-manager.users`, writes `mine.allowedUnfree` which is declared elsewhere). N/A for this file, but see cross-file note on `modules/users/nixos.nix` below — the two files duplicate this bridge logic verbatim (G1 candidate, not chased here since it's out of this batch's idiom-checklist scope and R4 didn't flag it).
6. **Confidence**: high.

#### modules/users/nixos.nix
1. **Purpose**: declare NixOS user accounts (`mine.users.*` submodule) and wire home-manager for them.
2. **Does**: `mine.users` submodule type (isSuperUser, description, hashedPasswordFile, uid, sshKeys, authorizedKeys, shell, home-modules); `trusted-users`/`mutableUsers`; an admin-exists assertion; an authorizedKeys-reference assertion; `users.users` mapping; the same unfree bridge as darwin.nix; HM wiring incl. per-user `home.username`/`home.homeDirectory`/`home.stateVersion`. Rubric B check: "declare users" (the submodule type + `users.users` mapping + assertions) and "wire home-manager" (useGlobalPkgs, extraSpecialArgs, per-user HM defaults, unfree bridge) are two jobs — they'd change for different reasons (a new account field vs. a new HM wiring need) and are two-thirds of this file's line count each. Verdict: **overloaded** — the home-manager wiring block (:118-134, plus the bridge :110-116 shared with darwin.nix) should move to a sibling file, e.g. `modules/users/home-manager.nix` imported alongside this one, leaving `nixos.nix` as pure account declaration.
3. **Comments**: :35-40 (uid rationale) and :44-47/:53-59 (sshKeys/authorizedKeys split rationale) are load-bearing — explain non-obvious cross-host invariants (devbox bind-mount uid coupling, opt-in authorization model). Keep all three. :81 (`# Make sure there is always at least 1 admin user`) is A1 restatement of the assertion message immediately below — cut. :110-113 duplicates darwin.nix's bridge comment nearly verbatim — same content, keep one copy conceptually but this is evidence for the G1-adjacent duplication noted above.
4. **Idiom**: none new (types.attrsOf/submodule, types.bool — none on R4's list).
5. **Namespace**: `mine.users.*` (isSuperUser, description, hashedPasswordFile, uid, sshKeys, authorizedKeys, shell, home-modules) — **miss**: this is neither `mine.system.*` nor `mine.user.*`, it's a bare third top-level namespace (`mine.users`, plural, sibling to `system`/`user` rather than nested under either). A reader following the `mine.system.*`/`mine.user.*` convention from every other module in this batch would not predict `mine.users.*` for system-level account declarations; it reads more like it should be `mine.system.users.*`, or the `system`/`user` split itself needs a documented third category for "account provisioning." This is the sharpest namespace finding in the batch — flag for GATE 2.
6. **Confidence**: high on the namespace and comment findings; medium on the overloaded verdict's exact split point (whether the bridge belongs in the new file or stays shared).

---

#### Cross-file: platform-split naming (alacritty vs. the rest)

Six directories in this batch split by platform. Five of them (`_1password`, `fish`, `niri`, `paseo-desktop`, plus `users`) use `home.nix` (user-scope, home-manager) paired with `nixos.nix`/`darwin.nix` (system-scope, imported into `modules/nixos.nix`/`modules/darwin.nix`). `alacritty` instead pairs `home.nix` with `linux.nix`, and has no `nixos.nix`/`darwin.nix` at all.

Traced the aggregators (`modules/home.nix`, `modules/home-darwin.nix`, `modules/nixos.nix`, `modules/darwin.nix`): `alacritty/linux.nix` is imported only by `modules/home.nix` (the Linux home-manager aggregator), not by `modules/nixos.nix` (the system aggregator) and not by `modules/home-darwin.nix`. So `linux.nix` is **not** the same concept as `nixos.nix` spelled differently — it operates on a different axis entirely: `nixos.nix`/`darwin.nix` split *system-scope* config by OS, while `alacritty/linux.nix` is a *home-manager-scope* file that's conditionally imported only on the Linux HM aggregator (alacritty has no system-level component to split out; its only cross-platform variation is a niri keybind, which only exists on Linux). alacritty/linux.nix:1's own comment confirms this: "Niri integration separated so the shared alacritty module can be imported on darwin."

This is a **C2 naming finding**, not G1 internal drift: the two files solve genuinely different problems (system-vs-user split, vs. HM-internal platform-conditional split), so there's no "converge on the newest" fix. But `linux.nix` sitting next to files elsewhere named `nixos.nix` for a superficially similar purpose (both "the Linux-specific piece") is exactly the kind of file-naming inconsistency C2 calls out — a reader scanning directory listings across modules cannot tell from the name alone which axis a given `*.nix` file splits on. No other module in this batch (or, per the aggregator scan, apparently in the repo) uses `linux.nix` for this pattern, so it's a one-off rather than a repo-wide drift — worth a one-line rename note (e.g. `alacritty/niri.nix` or `alacritty/linux-niri.nix` naming what it actually gates on) rather than a structural fix.

#### Cross-file: namespace summary

- 12 of 14 files' options are correctly predictable under `mine.system.*` / `mine.user.*`.
- **One real miss**: `modules/users/nixos.nix` declares `mine.users.*` (bare, plural, sibling-level) instead of nesting under `mine.system.*`. This is the batch's GATE 2 evidence — worth deciding whether `mine.users` is a deliberate documented third category (account provisioning spans both system and per-user concerns) or should become `mine.system.users`.
- `modules/users/darwin.nix` and `modules/paseo-desktop/darwin.nix` declare no new options themselves (config/bridge-only), so N/A rather than a miss.

#### Could not judge
- Whether `modules/users/nixos.nix`'s `mine.users` top-level namespace is intentional repo-wide policy (a third category alongside `system`/`user`) — would need to check other modules outside this batch for the same pattern before recommending a rename; flagged for GATE 2 rather than decided here.
- Exact target file for the `modules/users/nixos.nix` overloaded split (home-manager wiring) — named a plausible sibling (`modules/users/home-manager.nix`) but did not verify against repo-wide file-naming convention for split modules with more than two facets.

---

### TW ledger — batch 09 (35 files: avahi → unfree)

#### modules/avahi/nixos.nix
1. Purpose: enable the avahi mDNS service.
2. Does: one option, one config block. Verdict: coherent.
3. Comments: none.
4. Idiom: clean, no findings.
5. Namespace: `mine.system.avahi.enable` — matches (nixos.nix).
6. Confidence: high.

#### modules/battery-notifications/home.nix
1. Purpose: notify on battery level via a systemd user service.
2. Does: enable option, inline shell script, systemd unit, package. All facets of one job. Verdict: coherent.
3. Comments: 3 inline `# N minutes when...` (A1, restate the sleep value) — cuttable but trivial; not worth a task on their own.
4. Idiom: `Environment = "PATH=${pkgs.libnotify}/bin:..."` builds a PATH string, not an exec call — not a `getExe` candidate (PATH inclusion, not invocation).
5. Namespace: `mine.user.battery-notifications.enable` — matches.
6. Confidence: high.

#### modules/direnv/home.nix
1. Purpose: enable direnv with nix-direnv integration.
2. Does: one option, one config block. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.direnv.enable` — matches.
6. Confidence: high.

#### modules/docker/nixos.nix
1. Purpose: enable the docker daemon.
2. Does: one option, one config line. Verdict: coherent.
3. Comments: 1, "this is a lame wrapper but there used to be more here and there may be more in the future" — A3/A2 hybrid (justifies triviality + speculates on future). CUT.
4. Idiom: clean.
5. Namespace: `mine.system.docker.enable` — matches.
6. Confidence: high.

#### modules/encode_queue/home.nix
1. Purpose: install the encode_queue tool for the user.
2. Does: enable option + package option (default from local `package.nix`). Verdict: coherent.
3. Comments: none.
4. Idiom: clean — correctly uses `package.nix` per B7.
5. Namespace: `mine.user.encode_queue.*` — matches.
6. Confidence: high.

#### modules/encode_queue/package.nix
1. Purpose: build the encode_queue Rust binary from GitHub source.
2. Does: one derivation. Verdict: coherent (table-of-one, B7-compliant sibling to home.nix).
3. Comments: 2 — `# Fixes a build warning in nixos` above `pname` (A1/opaque, unclear what warning; borderline CUT — doesn't explain what warning or why pname fixes it), `# Opt in to the binary cache...` above `passthru.cache = true` (legitimate — non-obvious flag meaning, KEEP).
4. Idiom: clean.
5. Namespace: n/a (no `mine.*` options here).
6. Confidence: medium (can't verify what build warning the first comment refers to).

#### modules/gamescope/nixos.nix
1. Purpose: enable the gamescope compositor, optionally overlaid with a custom build.
2. Does: enable + overlay option, steam remotePlay firewall poke, conditional nixpkgs overlay pinning a newer gamescope. Facets of one job (get gamescope working). Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.gamescope.{enable,overlay}` — matches.
6. Confidence: high.

#### modules/gh/home.nix
1. Purpose: configure the gh CLI.
2. Does: one option, one config block. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.gh.enable` — matches.
6. Confidence: high.

#### modules/git/home.nix
1. Purpose: configure user git.
2. Does: one option, one config block. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.git.enable` — matches.
6. Confidence: high.

#### modules/hammerspoon/home.nix
1. Purpose: install Hammerspoon's PaperWM config and spoon.
2. Does: enable option, init.lua, fetched spoon. Verdict: coherent.
3. Comments: 1 header, "Hammerspoon PaperWM config; the app itself is installed via homebrew" — legitimate, load-bearing (explains why this module has no package). KEEP.
4. Idiom: clean.
5. Namespace: `mine.user.hammerspoon.enable` — matches.
6. Confidence: high.

#### modules/homebrew/darwin.nix
1. Purpose: configure nix-homebrew and homebrew cask lifecycle.
2. Does: nix-homebrew setup, homebrew activation policy. Both facets of "make homebrew casks declarative." Verdict: coherent. Note: unconditional — no `mine.*` enable option, unlike every other module in this batch.
3. Comments: 1 header, legitimate (explains the uninstall-undeclared policy up front). KEEP.
4. Idiom: clean.
5. Namespace: n/a — no option declared (see note above; not itself a defect, just the one outlier in the batch).
6. Confidence: high.

#### modules/hyprlax/home.nix
1. Purpose: run the hyprlax parallax wallpaper daemon.
2. Does: enable + scene option, systemd service, package, conditional niri layer-rule integration. Facets of one job. Verdict: coherent.
3. Comments: none.
4. Idiom: `${pkgs.hyprlax}/bin/hyprlax` at line 39 — hand-built exec path where `lib.getExe pkgs.hyprlax` applies (package's mainProgram is `hyprlax`). Same pattern as swaybg/swayidle below; not in R4's cited list but same family. Replacement already lives at `modules/local-llm/vllm-service.nix:17`.
5. Namespace: `mine.user.hyprlax.{enable,scene}` — matches.
6. Confidence: high.

#### modules/keybase/darwin.nix
1. Purpose: install Keybase via homebrew cask on darwin.
2. Does: one option, one cask line. Verdict: coherent.
3. Comments: 1 header, "Keybase manages its own services on darwin; the Linux module handles daemons" — legitimate, explains the darwin/home split with keybase/home.nix. KEEP.
4. Idiom: clean.
5. Namespace: `mine.system.keybase.enable` — matches.
6. Confidence: high.

#### modules/keybase/home.nix
1. Purpose: run Keybase services and install its clients for the user.
2. Does: enable option, keybase+kbfs services, packages. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.keybase.enable` — matches.
6. Confidence: high.

#### modules/lazygit/home.nix
1. Purpose: configure lazygit with the shared theme.
2. Does: enable option, theme-driven settings, shell alias. Verdict: coherent.
3. Comments: none.
4. Idiom: clean; theme consumed via `inherit (themeConstants) colors` like mako/swaylock (see cross-file note).
5. Namespace: `mine.user.lazygit.enable` — matches.
6. Confidence: high.

#### modules/makemkv/nixos.nix
1. Purpose: install makemkv with the kernel module it needs.
2. Does: enable option, allowedUnfree entry, kernel module, package. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.makemkv.enable` — matches.
6. Confidence: high.

#### modules/mako/home.nix
1. Purpose: configure the mako notification daemon with the shared theme.
2. Does: enable option, theme-driven settings including urgency overrides. Verdict: coherent (table: urgency levels are the same kind of thing).
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.mako.enable` — matches.
6. Confidence: high.

#### modules/nvidia/nixos.nix
1. Purpose: enable NVIDIA GPU support.
2. Does: enable + open-driver option, xserver driver, graphics/nvidia hardware config, kernel module for CUDA, allowedUnfree, CUDA cachix substituter. All facets of "make the NVIDIA GPU usable." Verdict: coherent.
3. Comments: 2 legitimate — `# CUDA normally autoloads...` (KEEP, load-bearing on the kernelModules line) and the substituter block comment explaining why max-jobs isn't clamped anymore (KEEP — current-state reasoning, not history of a failed approach).
4. Idiom: clean.
5. Namespace: `mine.system.nvidia.{enable,open}` — matches.
6. Confidence: high.

#### modules/obs-studio/home.nix
1. Purpose: configure OBS Studio with its wayland-capture plugins.
2. Does: one option, one config block. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.user.obs-studio.enable` — matches.
6. Confidence: high.

#### modules/openssh/nixos.nix
1. Purpose: configure inbound sshd and outbound ssh client behavior.
2. Does: inbound (sshd, firewall, assertion) + outbound (client env forwarding) — two independent facets (server vs client) gated by separate enable options, table-shaped. Verdict: coherent (B4 table of two).
3. Comments: 2 legitimate — the `AcceptEnv`/`SendEnv COLORTERM` pair (KEEP, cross-references its own counterpart, non-obvious truecolor gotcha) and the assertion message (not a comment, an actual assertion — fine).
4. Idiom: clean.
5. Namespace: `mine.system.openssh.{inbound,outbound}.enable` — matches.
6. Confidence: high.

#### modules/pipewire/nixos.nix
1. Purpose: run the PipeWire audio stack.
2. Does: enable (pipewire+alsa+pulse+rtkit+wireplumber) + sample-switch facet (extra 48kHz clock config). Verdict: coherent (table: two independently-gated pieces of one audio stack).
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.pipewire.{enable,sample-switch.enable}` — matches.
6. Confidence: high.

#### modules/polkit_kde/home.nix
1. Purpose: run the KDE polkit authentication agent as a user service.
2. Does: one option, one systemd unit. Verdict: coherent.
3. Comments: none.
4. Idiom: `${pkgs.kdePackages.polkit-kde-agent-1}/libexec/...` is a `/libexec/` path, not `/bin/` — outside R4's `getExe` signal (which targets `bin/`); not flagged.
5. Namespace: `mine.user.polkit-kde.enable` — matches (module dir is `polkit_kde`, option is `polkit-kde`; naming style mismatch only, not a namespace-tree miss).
6. Confidence: high.

#### modules/printing/nixos.nix — T5 target
1. Purpose: get print jobs to the one house printer via CUPS discovery, since driverless AirPrint means no static queue.
2. Does: one option, printing service with browsed disabled, avahi dependency. Verdict: coherent. (37 lines, 21 comment lines = 57%.)
3. Comments — per-comment verdict:
   - Lines 1, 3–7 (what the printer is, why no static queue, driverless/mDNS behavior): **KEEP-IN-PLACE**, trim to the operational fact (drop the flourish, keep "no queue is declared here because CUPS discovers this driverless printer via mDNS and builds one at print time").
   - Lines 9–13 ("An earlier version... ensurePrinters... failed on every boot"): **CUT**. Textbook rubric A2 — this is the rubric's own worked example almost verbatim. Git log has it; the current constraint is already restated in the kept lines above without needing the failed-approach narrative.
   - Lines 15–16 ("A local cupsd is not optional either way"): **KEEP-IN-PLACE**, trim — explains why `services.printing.enable = true` is still needed even though discovery is what matters.
   - Lines 27–30 (browsed.enable=false rationale): **KEEP-IN-PLACE** — non-obvious CUPS default behavior, adjacent to the line it justifies, passes the "10-minute re-derivation" test.
   - Line 34 (avahi/D-Bus): **KEEP-IN-PLACE** — short, adjacent, explains the `mine.system.avahi.enable = true` line right below it.
   - Net: cut ~5 lines (9–13), trim ~2 more blocks; comment ratio drops from 57% toward ~35-40%, all cut content is history, all kept content passes rubric A's keep-tests.
4. Idiom: clean.
5. Namespace: `mine.system.printing.enable` — matches.
6. Confidence: high.

#### modules/steambox/home.nix
1. Purpose: auto-launch Steam+gamescope on login for the steambox user.
2. Does: enable option, cross-module warning (checks system-level steambox is on), fish login-shell hook. Verdict: coherent.
3. Comments: none.
4. Idiom: clean; the `warnings` cross-check against `systemCfg.steambox.enable` is a nice pattern, not a finding.
5. Namespace: `mine.user.steambox.autoStart.enable` — matches.
6. Confidence: high.

#### modules/steambox/nixos.nix
1. Purpose: wire up steam+gamescope as a steambox's system dependencies.
2. Does: one option, enables steam+gamescope submodules, gamescope session. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.steambox.enable` — matches.
6. Confidence: high.

#### modules/steam/nixos.nix
1. Purpose: enable Steam.
2. Does: enable + remotePlay option, allowedUnfree entries. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.steam.{enable,remotePlay}` — matches.
6. Confidence: high.

#### modules/swaybg/home.nix
1. Purpose: run swaybg as the wallpaper background service.
2. Does: enable option, wallpaper file, systemd service, package, conditional niri layer-rule. Verdict: coherent.
3. Comments: none.
4. Idiom: **`${pkgs.swaybg}/bin/swaybg` at line 31** — R4-cited hand-built exec path; `lib.getExe pkgs.swaybg` applies directly (package's mainProgram is `swaybg`). Replacement pattern already at `modules/local-llm/vllm-service.nix:17`.
5. Namespace: `mine.user.swaybg.enable` — matches.
6. Confidence: high.

#### modules/swayidle/home.nix
1. Purpose: lock/dim/suspend on idle timeouts under niri.
2. Does: enable option, a `let`-block of hand-built exec strings, timeout table, event table. Verdict: coherent (table: the timeout/event lists are the same kind of thing).
3. Comments: none.
4. Idiom: **hand-built `${pkg}/bin/x` paths, R4-cited plus one more found here**:
   - Line 11 `${pkgs.brightnessctl}/bin/brightnessctl`, line 12 `${pkgs.niri}/bin/niri`, line 45 `${pkgs.systemd}/bin/systemctl` — straightforward `lib.getExe`/`lib.getExe' pkgs.systemd "systemctl"` candidates.
   - Line 13 `${pkgs.swaylock-effects}/bin/swaylock` — **caveat**: binary name (`swaylock`) differs from package attr name (`swaylock-effects`); only convertible if `pkgs.swaylock-effects.meta.mainProgram == "swaylock"` (need to verify before converting — same caveat R4 already flags for this file).
   - Replacement pattern already at `modules/local-llm/vllm-service.nix:17`.
5. Namespace: `mine.user.swayidle.enable` — matches.
6. Confidence: high, except the swaylock-effects mainProgram check (unverified).

#### modules/swaylock/home.nix
1. Purpose: configure swaylock-effects with the shared theme.
2. Does: enable option, large but single-purpose settings table (every entry is a color/effect knob). Verdict: coherent (table, B4).
3. Comments: none.
4. Idiom: clean; theme consumed directly via `themeConstants.colors.*` rather than the `inherit (themeConstants) colors;` pattern used in lazygit/mako (functionally identical, cosmetic only — see cross-file note).
5. Namespace: `mine.user.swaylock.enable` — matches.
6. Confidence: high.

#### modules/tailscale/nixos.nix
1. Purpose: run Tailscale and optionally allow SSH over the tailnet.
2. Does: enable + ssh option, tailscale service, cross-module openssh.inbound wiring, tailnet firewall rule. Verdict: coherent.
3. Comments: none (the option's own `description` carries the ssh-requires-openssh note, appropriately in-option rather than as a comment).
4. Idiom: clean.
5. Namespace: `mine.system.tailscale.{enable,ssh}` — matches.
6. Confidence: high.

#### modules/teamspeak-client/nixos.nix
1. Purpose: install the Teamspeak client.
2. Does: enable option, allowedUnfree entry, package. Verdict: coherent.
3. Comments: none.
4. Idiom: clean.
5. Namespace: `mine.system.teamspeak-client.enable` — matches.
6. Confidence: high.

#### modules/unfree/{darwin,home,nixos,options}.nix — explicit split judgement
- **options.nix**: declares `mine.allowedUnfree` (the shared interface). Coherent, single job.
- **darwin.nix** / **nixos.nix**: each imports options.nix and sets `nixpkgs.config.allowUnfreePredicate` from it — **identical 3-line predicate lambda duplicated verbatim between the two files**.
- **home.nix**: imports options.nix only, no config (home-manager doesn't own `nixpkgs.config`; values propagate up to system scope via the users module per options.nix's own docstring).
- **Judgement**: the split itself is B1-coherent — it follows this repo's established per-platform file convention (nixos.nix/darwin.nix/home.nix as facets of one option surface), not over-decomposition; 30 lines across 4 files is consistent with every other module in this batch. The one real finding is the duplicated predicate lambda between darwin.nix and nixos.nix (3 lines each) — a candidate for extraction into a shared snippet, but too small (6 total duplicated lines) to justify a task on its own; note and drop per G3.
- Comments: options.nix has one legitimate multi-line `description` (not a comment, it's the option's own docs — correct place for this, KEEP as-is).
- Namespace: `mine.allowedUnfree` — sits directly under `mine.*`, not `mine.system.*`/`mine.user.*`, because it's genuinely shared across both scopes (per its own description). Correct exception, not a miss.
- Confidence: high.

---

#### Idiom summary (cross-file)

**G1 — hand-built `${pkg}/bin/x` vs `lib.getExe`** (extends R4's finding with 2 more sites found in this batch):
- `modules/swaybg/home.nix:31` (R4-cited)
- `modules/swayidle/home.nix:11,12,45` (R4-cited: brightnessctl, niri, systemctl) **+ line 13** (swaylock-effects, new — caveat on mainProgram)
- `modules/hyprlax/home.nix:39` (new, not in R4's list) — `${pkgs.hyprlax}/bin/hyprlax`
- All from the same oldest-generation home.nix files (hyprlax/swaybg/swayidle predate `getExe` as house style, consistent with R4's dating). Reference/replacement: `lib.getExe`/`lib.getExe'`, newest spelling at `modules/local-llm/vllm-service.nix:17`.
- `polkit_kde/home.nix:19` uses `/libexec/`, not `/bin/` — out of scope for this pattern, not flagged.

**Not a G1 finding (checked, no defect)**: enable-option declaration style varies cosmetically across this batch — some files destructure `inherit (lib) mkEnableOption mkIf; cfg = config.mine...;` in a `let` (battery-notifications, direnv, gamescope, hyprlax, encode_queue, makemkv, mako, nvidia, pipewire, steambox/home, steam, swaybg, swayidle, swaylock, teamspeak-client), others call `lib.mkEnableOption`/`lib.mkIf` inline with no `let`/`cfg` (avahi, docker, gh, git, keybase/darwin, keybase/home, obs-studio, printing uses a hybrid — `let cfg` but inline `lib.mkIf`). Both spellings are equally short and equally hard to get wrong; neither clears G3 over the other. Recorded, not actioned.

**Theme consumption**: `inherit (themeConstants) colors;` (lazygit, mako) vs directly qualifying `themeConstants.colors.*` (swaylock). Cosmetic only, no functional difference, doesn't clear G3.

#### Namespace summary
No misses in this batch. One documented exception (`mine.allowedUnfree`, intentionally scope-agnostic, self-documented) and one file with no option at all (`modules/homebrew/darwin.nix`, unconditional by design). Every other option in the batch matches `mine.system.*` for nixos.nix/darwin.nix and `mine.user.*` for home.nix as a reader would predict.

---

### TW walk — batch 10: hosts/{elitebook,mac,paynefield,redtruck,t495,vps}

15 files. read-only survey, no edits outside this file.

---

#### hosts/elitebook/default.nix
1. **Purpose**: declare elitebook's system/user policy (desktop workstation, steambox, jellybox).
2. **Does**: imports (hw+disko+base modules+4 users); systemPackages table; **inline wireplumber
   default-volume config as raw INI text** (:19-24); `mine.system.*` policy block; per-user
   `mine.user.*`/`programs.*` block; steambox autostart for two users. Verdict: **overloaded**.
   Move the `environment.etc."wireplumber/...".text` block to `modules/pipewire/nixos.nix` as a
   new suboption (e.g. `mine.system.pipewire.defaultVolume`), mirroring the existing
   `sample-switch` suboption in that same file (`modules/pipewire/nixos.nix:12-13`, which already
   generates a wireplumber `extraConfig.pipewire` stanza from an option instead of host-inlined
   text). This is B8 exactly: a host wrote *how* wireplumber is configured, not just *that* it is.
3. **Comments**: 0 lines.
4. **Idiom**: none beyond R4's settled list.
5. **Namespace**: `mine.system.jellybox`/`steambox`/`renderGroupGid` — predictable (system
   containers/hardware). No misses.
6. **Confidence**: high.

#### hosts/elitebook/disko.nix
1. **Purpose**: declare elitebook's disk layout for disko.
2. **Does**: one disk (`/dev/nvme0n1`), GPT, ESP+swap+root, plain ext4 root (no LUKS). Verdict:
   coherent/table.
3. **Comments**: 0.
4. **Idiom**: see cross-file disko comparison below — uses unstable `/dev/nvme0n1` device path and
   no encryption; both are drift relative to the newer redtruck layout.
5. **Namespace**: n/a (no `mine.*`).
6. **Confidence**: high.

#### hosts/elitebook/hardware-configuration.nix
Generated by `nixos-generate-config` (line 1 states this). Out of scope for editing — no findings.

#### hosts/mac/default.nix
1. **Purpose**: declare mac's darwin system/user policy.
2. **Does**: darwin module import; dock defaults; user account; `mine.system.*` toggles; homebrew
   casks table; home-manager `mine.user.*`/`programs.*` including git signing config. One
   load-bearing comment (:38-39, explains why shared apps aren't cask-listed here). Verdict:
   coherent/table.
3. **Comments**: 1 line, keeps (explains a boundary a reader would otherwise violate by adding a
   shared app to the cask list).
4. **Idiom**: none new.
5. **Namespace**: `mine.system.paseo-desktop.enable` looks like a miss at first (elsewhere it's
   `mine.user.paseo-desktop`) but is intentional — `modules/paseo-desktop/darwin.nix:5,11` defines
   a system-level darwin trigger that forwards to `mine.user.paseo-desktop.enable` internally
   (homebrew cask needs system-level install). Not a finding.
6. **Confidence**: high.

#### hosts/paynefield/default.nix
1. **Purpose**: declare paynefield's server-host policy (media/task/DNS server box).
2. **Does**: imports; systemPackages; 3 `sops.secrets` declarations; `mine.system.*` server
   toggles; `mine.backups.*`; authorizedKeys; home-manager block. Verdict: coherent/table.
3. **Comments**: 0.
4. **Idiom**: sopsFile repetition — see cross-file summary; **2/3** secrets here repeat
   `../../secrets/hosts/paynefield.yaml` (:17,:25), third uses a different file (:21).
5. **Namespace**: `mine.system.dns-server`, `jellyfin-server`, `immich-server`,
   `terraria-server`, `vikunja-server` — all predictable as system daemons. `mine.backups.*` is a
   third top-level namespace (sibling of `system`/`user`), used consistently repo-wide (see
   summary) — not a per-host miss.
6. **Confidence**: high.

#### hosts/paynefield/hardware-configuration.nix
Generated by `nixos-generate-config` (line 1 states this). Out of scope — no findings.

#### hosts/redtruck/default.nix (named T8 target)
1. **Purpose**: declare redtruck's desktop+GPU+devbox-host policy — actually two policies bolted
   together (desktop workstation *and* coding-agent container host), which is itself a B5 smell
   ("and").
2. **Does** (222 lines): imports; systemPackages; **6 `sops.secrets` declarations at :50-73 with a
   34-line comment block at :16-49 justifying the mode/owner choice per secret type**; `mine.system.*`
   policy incl. `devboxes` attrset (:104-121, with a 5-line rationale comment :99-103); per-user
   home-manager block; a 3-line zramSwap rationale comment (:208-210); tmpfiles rules. Verdict:
   **overloaded**. Concretely:
   - **:16-49** (34-line comment: container secret-mount contract, mode/owner rationale per secret
     type, rotation instructions) is module documentation wearing a host file, not host policy —
     move to `modules/devbox/nixos.nix`, which already carries the doc-comment header for
     `mine.system.devboxes` (`modules/devbox/nixos.nix:1-17`) and the per-field `description`
     strings on `githubTokenFile`/etc (same file, ~line 60+) — the mode/owner/uid rationale
     belongs right next to those option descriptions, not repeated at every host that uses devboxes.
   - **:50-73** (6 near-identical `sops.secrets.<name>.sopsFile = ../../secrets/hosts/redtruck.yaml`
     declarations, one pair per container: github-token/paseo-password/signing-key × 2) could be
     generated by `modules/devbox/nixos.nix` from the `devboxes` attrset itself — the module
     already knows each instance needs exactly these three secrets with exactly these
     mode/owner rules (it documents them in the options' `description`s); a host should only need
     to set one `sopsFile` per container (or one per host, see summary) and name the instance,
     not restate the mode/owner contract 6 times. This is the FINDINGS.md claim, confirmed with
     line numbers.
   - **:99-103** (devboxes rationale — "paths come from sops.secrets... so a layout change can't
     silently desync them") is defensible as a load-bearing comment (A-rubric keep) but is really
     explaining the *pattern*, which again belongs with the module's option descriptions, not
     re-derived per host.
3. **Comments**: ~40 comment lines total; the 34-line block (:16-49) is A2+A3+A5 (history +
   per-secret justification + design prose) — cut/move per above. The :99-103 (5 lines) and
   :208-210 (3 lines, zram sizing rationale) are shorter, closer to "load-bearing constraint," and
   pass the A-rubric keep-test as-is if they stay host-side.
4. **Idiom**: confirms R4 G1#2 — `:56` and `:67` (`devbox-paseo-password.sopsFile = ...;` /
   `workbox-paseo-password.sopsFile = ...;`, dotted-path) vs siblings `:51-54`/`:57-61`/`:62-66`/
   `:68-72` (nested `{ sopsFile = ...; mode = ...; }`), same `sops.secrets` block. Also confirms
   R4 G2#3: **6/6** secrets in this file repeat the identical `../../secrets/hosts/redtruck.yaml`
   path (not 6/7 as R4's note states — this file has exactly 6 `sops.secrets` entries, all
   identical; R4's count is off by one, actual repo grep confirms 6 `sopsFile =` lines total, all
   `redtruck.yaml`). `sops.defaultSopsFile` is unset repo-wide (`grep -rn defaultSopsFile .` →
   no hits), confirmed.
5. **Namespace**: `mine.system.teamspeak-client.enable` (:130) is a miss — `modules/teamspeak-client/nixos.nix`
   only adds a `systemPackages` entry (no service, no per-user config), so it reads exactly like
   every other client app in this repo (alacritty, firefox, mako, lazygit — all `mine.user.*`).
   A reader would predict `mine.user.teamspeak-client`. Everything else (`local-llm`, `nvidia`,
   `nas`, `devboxes`, `avahi`, `printing`) is correctly system-shaped.
6. **Confidence**: high — this file is the batch's clearest B8 case.

#### hosts/redtruck/disko.nix
1. **Purpose**: declare redtruck's 5-disk layout (boot/root + 4 bulk-storage disks) for disko.
2. **Does**: main disk (LUKS-encrypted swap+root) + 4 plain-ext4 bulk disks, all by-id device
   paths. One entry per disk, all the same *kind* of thing. Verdict: coherent/table.
3. **Comments**: 0.
4. **Idiom**: this is the **newest** disko.nix in the repo (last touched 2026-07-10, vs
   2026-05-06 for elitebook/t495 and 2026-04-29 for vps) — treated as reference for the
   cross-file comparison below.
5. **Namespace**: n/a.
6. **Confidence**: high.

#### hosts/redtruck/filesystems.nix
1. **Purpose**: mount redtruck's 4 bulk-storage filesystems (companion to disko.nix's 4 bulk
   disks) and expose them as home symlinks.
2. **Does**: `mine.system.boot.partitionUuid`; 4 `fileSystems` entries sharing `stdOptions`; a
   tmpfiles rule for `/mnt/games` (1-line comment, keep — explains a non-obvious mode); a
   home-manager sharedModule creating `~/games`, `~/media`, etc. as out-of-store symlinks to the
   mountpoints. All facets of "make the 4 bulk disks usable" — verdict coherent (B1).
3. **Comments**: 1 line (`# Steam writes to this directory`), keep — short, load-bearing for the
   2770 mode choice.
4. **Idiom**: none new.
5. **Namespace**: `mine.system.boot.partitionUuid` — predictable.
6. **Confidence**: high.

#### hosts/redtruck/hardware-configuration.nix
Generated by `nixos-generate-config` (line 1 states this). Out of scope — no findings.

#### hosts/t495/default.nix
1. **Purpose**: declare t495's laptop desktop policy.
2. **Does**: imports (4 users); systemPackages; `boot.initrd.systemd.enable`; `mine.system.*`
   incl. a 1-line hardware-justified comment (:35, font sizes for the higher-DPI screen, keep);
   home-manager block; steambox autostart. Verdict: coherent/table.
3. **Comments**: 1 line, keep.
4. **Idiom**: none new.
5. **Namespace**: same shape as elitebook/redtruck; `teamspeak-client.enable` (:47) has the same
   miss noted under redtruck (system vs. expected user namespace) — see summary.
6. **Confidence**: high.

#### hosts/t495/disko.nix
1. **Purpose**: declare t495's disk layout.
2. **Does**: one disk (`/dev/nvme0n1`), GPT, ESP+swap(LUKS random-encryption)+root(LUKS). Verdict:
   coherent/table.
3. **Comments**: 0.
4. **Idiom**: matches redtruck's LUKS+randomEncryption idiom but still uses the unstable
   `/dev/nvme0n1` device path — see cross-file comparison.
5. **Namespace**: n/a.
6. **Confidence**: high.

#### hosts/t495/hardware-configuration.nix
Generated by `nixos-generate-config` (line 1 states this). Out of scope — no findings.

#### hosts/vps/default.nix
1. **Purpose**: declare vps's mail/booking-site/edge server policy.
2. **Does**: imports (qemu-guest profile); boot mode override (1-line comment, keep); zramSwap
   with a 6-line sizing rationale (:20-25, borderline A3/A5 but quantified/specific — keep as-is,
   don't chase); 4 `sops.secrets`; `mine.system.*` server toggles each with a short adjacent
   comment (stalwart :70-73, caddy SNI-edge :75-81 — the longest at 7 lines but explains a
   genuinely non-obvious routing split, keep); `mine.backups.*`; home-manager block. Verdict:
   coherent — comment-dense (≈25% of lines) but each block passes the A-rubric keep-test
   individually; no code/implementation smuggled in (unlike redtruck).
3. **Comments**: ~25 lines across 6 blocks; all pass keep-test on inspection (operational
   constraints specific to this box — RAM size, disk layout, DNS/cert delegation) rather than
   restated code or generic history.
4. **Idiom**: sopsFile repetition confirmed — **3/4** `sopsFile =` lines in this file
   (:42,:50,:90) repeat `../../secrets/hosts/vps.yaml`; the 4th (:46) is a different file
   (`restic-b2.yaml`). Matches R4 G2#3 (line numbers shifted by ~1 from R4's citation but same
   finding).
5. **Namespace**: `mine.system.stalwart-server`, `caddy`, `teamspeak-server`, `photoform` —
   predictable system daemons. No misses.
6. **Confidence**: high.

#### hosts/vps/disko.nix
1. **Purpose**: declare vps's single-disk VM layout (BIOS/GRUB, no swap).
2. **Does**: one disk, GPT, 1M BIOS-boot stub (`EF02`) + ext4 root, `lib.mkDefault` on the device
   path. Verdict: coherent — intentionally different topology (cloud VM, not a physical host with
   removable media), documented by the `mine.system.boot.mode = "grub-bios"` comment in
   `default.nix:17`.
3. **Comments**: 0.
4. **Idiom**: partition key is `disk.disk1` here vs `disk.main` in the other three hosts — naming
   inconsistency, but low-stakes (single-disk file, no G3 payoff to renaming). Note only.
5. **Namespace**: n/a.
6. **Confidence**: high.

---

#### Cross-file: disko.nix comparison (4 files)

Reference: **`hosts/redtruck/disko.nix`** (newest, 2026-07-10). t495 (2026-05-06) and elitebook
(2026-05-06) predate it; vps (2026-04-29) is oldest but is a legitimately different topology
(cloud VM, no removable disks, BIOS boot) and is excluded from the "should converge" comparison.

Divergences from redtruck, elitebook vs t495:
- **Device addressing**: redtruck uses stable `/dev/disk/by-id/...` paths (:10,:59,:75,:91,:107).
  elitebook (`:11`) and t495 (`:10`) both still use the unstable `/dev/nvme0n1`. This is a real
  G1 finding: by-id paths survive device renumbering across kernel/driver changes, by-id is not
  longer or harder to write than the bare `/dev/nvme0n1` form — meets G3. Converge elitebook/t495
  onto by-id, using redtruck as the reference.
- **Root encryption**: t495 and redtruck both LUKS-encrypt root+swap (`randomEncryption` on swap,
  `cryptroot` LUKS on root). elitebook has neither — plain ext4 root, plain swap. This reads as a
  deliberate per-machine security posture difference (elitebook may be a less sensitive box), not
  drift — note only, don't converge without confirming with the user.
- **Partition key naming**: `disk.main` (elitebook/t495/redtruck) vs `disk.disk1` (vps) — minor,
  low-stakes, note only (see vps section above).
- ESP size (512M redtruck vs 1G elitebook/t495) and swap size vary per-host; these are legitimate
  per-machine sizing choices, not idiom drift.

#### Cross-file: sopsFile repetition (F2 / R4 G2#3)

Per-host counts of `sopsFile = <same path>` repeated across sibling `sops.secrets`/module
`sopsFile` declarations, verified by grep against this batch:
- **redtruck**: 6/6 (all secrets, `redtruck.yaml`) — not 6/7 as R4's note states; this file has
  exactly 6 `sopsFile` lines, all identical, no 7th.
- **vps**: 3/4 (`vps.yaml`; the 4th is `restic-b2.yaml`, a genuinely different file).
- **paynefield**: 2/3 (`paynefield.yaml`; the 3rd is `restic-b2.yaml`).
- `sops.defaultSopsFile` is unset repo-wide — confirmed, no hits.
- elitebook/mac/t495 declare no `sops.secrets` at all — not applicable.

#### Namespace summary (GATE 2 input)

Real miss found in this batch: **`mine.system.teamspeak-client.enable`** (redtruck :130, t495 :47).
The module (`modules/teamspeak-client/nixos.nix`) does nothing system-shaped — it only appends an
`environment.systemPackages` entry, no service, no per-user state. Every other client app in this
repo's host files (alacritty, firefox, mako, lazygit, gh, git, hyprlax, swaylock...) lives under
`mine.user.*`. A reader scanning these host files would guess `mine.user.teamspeak-client` and be
wrong. This is a genuine, cheap rename candidate (one option, two call sites), not a documented
no-op.

Checked and ruled out as false positives: `mine.system.paseo-desktop` on mac (intentional darwin
forwarding shim, see mac section) and `mine.backups.*`/`mine.users.*` (a third top-level namespace
used consistently across ~10 modules repo-wide per grep, not something this batch alone can judge
as incoherent — flag for whoever owns the full-repo namespace summary to confirm the pattern holds
outside `hosts/`).

#### Verdict tally (15 files)
- coherent/table: 11 (elitebook/disko, mac/default, paynefield/default, redtruck/disko,
  redtruck/filesystems, t495/default, t495/disko, vps/default, vps/disko — 9 substantive +
  2 borderline-but-passing)
- overloaded: 2 (elitebook/default.nix — inline wireplumber text; redtruck/default.nix — sops
  rationale essay + generatable secret block)
- out of scope (generated, confirmed line-1 disclaimer): 4 (the 4 `hardware-configuration.nix`)

---

### Ledger shard 11 — flake plumbing, aggregators, users/*, tests/*

Batch: checks/default.nix, devshell.nix, flake.nix, modules/darwin.nix,
modules/home-darwin.nix, modules/home.nix, modules/nixos.nix,
packages/default.nix, tests/devboxes.nix, tests/photoform.nix,
users/{jellyuser,sumriri,sword,waktu}.nix (14 files).

---

#### flake.nix (116 lines)

**Purpose:** declare the flake's inputs and outputs for every host and dev
surface this repo provides.

**Does:** inputs block (home-manager/disko/sops-nix/nix-darwin/nix-homebrew/
mac-app-util/nixpkgs/paseo) · `devShells` (delegates to `./devshell.nix`) ·
`formatter` · `packages` (delegates to `./packages`) · `checks.x86_64-linux`
(delegates to `./checks`) · `darwinConfigurations` · `nixosConfigurations`.
All facets of one job ("assemble the flake"). **Verdict: coherent.** T9's cut
from 247→116 lines by extraction landed; no leftover bloat here.

**Comments (12 lines, all judged individually — none are A1):**
- L20-21 (mac-app-util trampoline/Spotlight) — real non-obvious vendor fact,
  keep, but 2 lines for a fact that fits in one.
- L24-25 (collapse mac-app-util's transitive pins) — justifies the adjacent
  4-line `inputs.*.follows` block directly below it; passes the load-bearing
  test. Keep.
- L34-36 (paseo daemon, 3 lines) — weakest of the six: explains upstream
  shape and repeats the reason for `nixpkgs.follows` already implied by every
  other input's identical `.follows = "nixpkgs"` line. A3-leaning; compress to
  one line ("keeps container on shared nixpkgs store") or cut.
- L57-59 (nixfmt-tree vs bare nixfmt) — genuine operational gotcha
  (deprecated dir-arg, `.direnv` symlink walk); clears the keep-test outright.
- L66-67 (why checks live under one system) — short, load-bearing, keep.

Net: 2 solid keeps, 2 keeps-but-could-shrink, 1 (paseo) that's the closest
thing to a cut here. This is a defensible state for the user's "comments
look bad" complaint — the file is not accumulating restatement, it has six
small justification notes and only one is genuinely weak.

**Idiom:** none beyond R4's list. No `''` blocks in this file.

**Namespace:** n/a, no `mine.*` options declared.

**Confidence:** high.

---

#### checks/default.nix (102 lines, 15 comment lines)

**Purpose:** produce the flake's `checks.x86_64-linux` attrset — everything
`nix flake check` gates CI on.

**Does (5 facets):** eval-only checks for every nixos/darwin host (generated
from `inputs.self.*Configurations`, not hand-listed) · re-export of
`tests/devboxes.nix` and `tests/photoform.nix` as named checks · lint checks
(`fmt-check`, `statix-check`, `deadnix-check`) · one check per flake package
(`pkg-<name>`) · one check per caddy host validating its rendered Caddyfile
(`caddyfile-<name>`). **Verdict: table, not overloaded.** Every entry is the
same *kind* of thing — "a derivation that fails CI if something is broken" —
even though the somethings differ (eval vs lint vs syntax vs build). T9 did
not just relocate an overloaded file; grouping "all CI-gating checks" under
one file is itself a single, correctly-scoped reason to exist. No further
split recommended.

**Comments:** 15 lines, all outside `''` blocks (checked — none of the three
`runCommand` shell bodies carries a comment). All five are the "load-bearing
constraint on nearby code" kind (why `evalAll` is generated not listed, why
the hw-config glob exists, why `git init -q -Af` is required for fmt-check to
walk correctly, why `nix flake check`'s cache-skip makes an unchanged package
free, why the caddyfile check exists). None restate code. Keep all.

**Idiom:** none new.

**Namespace:** n/a.

**Open question resolved:** checks/ vs tests/ — checks/ is the flake-output
*plumbing* (host evals, lint, package/caddyfile syntax gates, plus importing
the two tests/ files as two more entries); tests/ holds per-module
pure-eval property tables. The boundary is real: tests/ files never touch
lint or the package/host-eval machinery, and checks/ never asserts a domain
invariant itself, it only aggregates. Not a rename target, but the repo has
no doc stating this (rubric C1) — worth one line in a root README if T13
adds one.

---

#### packages/default.nix (6 lines)

**Purpose:** expose the repo's out-of-tree derivations as the flake's
`packages` output.

**Does:** `callPackage` three module-owned `package.nix` files
(encode_queue, caddy-l4, photoform) into one attrset. **Verdict: coherent**
(trivially — one line per package, one job).

**Naming question resolved:** `packages/` holding only wiring while the
derivations live in `modules/*/package.nix` is not a naming defect — it is
rubric B7 working as intended ("package definitions live in package.nix, not
inline"). `packages/default.nix` is correctly named for what it produces: the
flake's `packages` output. No rename needed.

**Comments:** none. **Idiom:** none. **Namespace:** n/a. **Confidence:** high.

---

#### devshell.nix (9 lines)

**Purpose:** the repo's own dev shell (nixfmt, sops, statix, deadnix).
**Does:** one `pkgs.mkShell`. **Verdict: coherent.** **Comments:** none.
**Idiom:** none. **Namespace:** n/a. **Confidence:** high.

---

#### Aggregators — modules/{nixos,home,darwin,home-darwin}.nix (T10)

Cross-checked every module directory on disk against all four import lists.

**Missing import — confirmed, real:** `modules/theme/home.nix` exists (sets
`home.pointerCursor`, `gtk`, `qt`, dconf color-scheme — real, sizeable Linux
theming config) and is imported **nowhere** — not in `modules/home.nix`, not
in `modules/home-darwin.nix`, not referenced by any host. `grep -rn
"theme/home"` across the repo returns zero hits besides the file itself.
`modules/theme/darwin.nix` and `modules/theme/nixos.nix` are both wired; only
the home-manager half is orphaned. This is a half-wired module: every Linux
host is silently missing GTK/QT/cursor theming from what the module clearly
intends to ship. **This is the single most valuable finding in this shard.**

Checked and cleared as a false alarm: `modules/pi-coding-agent/home.nix` is
also absent from `modules/home.nix`, but by design — it's imported directly
by `modules/devbox/container.nix:146` for container-only scope, not a
missing aggregator wire.

**Ordering — `modules/nixos.nix` (42 lines), two violations, not one:**
FINDINGS.md's claim is confirmed and there's a second instance it didn't
catch:
- `./devbox/nixos.nix` (line 21) sits after `./openssh` (line 20); it
  alphabetically belongs between `./dns-server` and `./docker` (lines 8-9).
- `./pipewire/nixos.nix` (line 22) sits before `./photoform/nixos.nix`
  (line 23); "photoform" < "pipewire" alphabetically, so these two are also
  swapped.
`modules/darwin.nix`, `modules/home-darwin.nix`, `modules/home.nix` are all
correctly alphabetized top to bottom — no further findings there.

**Derive vs hand-list:** given a real missing-import bug just surfaced by
hand-listing, `lib.filesystem.listFilesRecursive` (or an explicit
allowlist-by-exception if some modules must stay opt-in, e.g. pi-coding-agent)
would make this class of bug structurally impossible rather than
review-dependent. Recommend for T10: convert at least `nixos.nix` and
`home.nix`, the two with the most entries and the ones that just proved
error-prone.

**Comments:** `modules/home-darwin.nix` L1 (Darwin-safe subset rationale) —
keep, load-bearing. Others: none.

**Namespace:** n/a, these are pure import lists.

**Confidence:** high on the missing-import and ordering findings (both
verified against `find`/`grep`, not inferred).

---

#### tests/devboxes.nix (279 lines, 54 comment lines) and tests/photoform.nix
(258 lines, 56 comment lines)

**Purpose (each):** pin the module's behavior to eval-time-visible
assertions so a refactor that breaks it fails CI instead of surfacing live
(devboxes: multi-instance wiring; photoform: the app's env/secret contract
plus the caddy edge routing).

**Does:** both are a `checks = [ {name; ok;} ... ]` list plus one
`runCommand` that fails on any `ok == false`. **Verdict: table (B4).**
Every entry is the same kind of thing — one named boolean assertion — even
though the domain facts differ. Not overloaded; length is irrelevant here,
this is exactly the "thirty language definitions" case rubric B4 describes.
Confirms FINDINGS.md's flag was worth checking but resolves to "fine as is."

**Comments:** ~19-22% of lines, below the ~30% smell threshold. Nearly all
are the keep-test's "load-bearing constraint" case — each explains a
non-obvious failure mode the adjacent assertion exists to catch (e.g.
photoform.nix:225-229 ties an assertion to a real prior outage: "would
silently reinstate the exact mail-TLS-renewal outage this branch exists to
undo" — borderline A2/history phrasing but the sentence also states a live
consequence, not just what happened, so it survives the keep-test). One
clear A2 candidate: devboxes.nix has no bare-history comments; photoform's
handful of incident-referencing comments (L211, L226-229, L239-240) all
double as forward-looking invariants, so none are flagged as A2 outright —
noted as borderline, not cut.

**Idiom:** none beyond R4's list. `piData`/`pluginMembership`/`llmCatalog`
imported as pure data (devboxes.nix:100-105) matches the repo's stated
"membership only, no versions" convention — consistent, not drift.

**Namespace:** n/a (test files, no options declared).

**Confidence:** high.

---

#### users/{jellyuser,sumriri,sword,waktu}.nix

**Purpose (each):** declare one system user account and its password-hash
secret.

**Does:** identical shape — `sops.secrets."<name>/password_hash"` (sopsFile
+ key + neededForUsers) then `mine.users.<name> = { description; uid;
hashedPasswordFile; ... }`. **Verdict: coherent**, all four.

**G1 internal drift:** none found. jellyuser/sumriri/sword are structurally
identical (description, uid, hashedPasswordFile only). waktu additionally
carries `isSuperUser`, `sshKeys`, `nasAccess`, `home-modules` — this is not
drift, it's the admin account legitimately using more of the same
`mine.users.<name>` submodule surface declared once in
`modules/users/nixos.nix`. Key ordering, secret-path pattern
(`../secrets/users/<name>.yaml`), and the `sops.secrets.<>.path` back-
reference are byte-for-byte the same pattern across all four.

**Namespace:** `mine.users.<name>` (plural) is correct and matches where
`modules/users/nixos.nix:17` and `modules/filesystems/nas.nix:77` declare
`options.mine.users`. Flagging for the namespace *summary* (not a per-file
miss): `mine.users.*` (plural, system account registry) sits one letter away
from the ~15-site `mine.user.*` (singular, per-user home-manager toggle)
convention seen throughout `modules/*/home.nix`. Both are internally
consistent and correctly used everywhere checked, but the near-collision is
a real readability tax — worth noting for GATE 2, not necessarily a rename.

**Comments:** zero across all four files. **Idiom:** none. **Confidence:**
high.

---

#### Cross-file summary

**Idiom summary:** nothing new beyond R4's checklist; no G1/G2 instances in
this batch's files that R4 didn't already cite.

**Namespace summary:** `mine.users.*` vs `mine.user.*` singular/plural
near-collision (see above) is the one namespace observation from this batch;
every option in the batch's own files resolves to its documented namespace
correctly, so this is a "note for GATE 2," not an incoherence finding.

**Verdict tally (14 files):** coherent 6 (flake.nix, packages/default.nix,
devshell.nix, modules/darwin.nix, modules/home-darwin.nix, modules/home.nix)
+ coherent 4 (users/*.nix) = 10 coherent · table 3 (checks/default.nix,
tests/devboxes.nix, tests/photoform.nix) · overloaded 0 · aggregator
modules/nixos.nix counted separately below (coherent-as-list, but carrying
two real bugs).

**modules/nixos.nix:** coherent as a file (it's an import list, B1), but
carries the batch's highest-value finding: one silently-missing import
(`theme/home.nix`, orphaned entirely, not this file's list — see aggregator
section) plus two ordering violations (`devbox`, and `photoform`/`pipewire`
swapped) inside `modules/nixos.nix` itself.
