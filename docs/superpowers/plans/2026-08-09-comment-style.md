# Comment Style: Blunt Reasons Only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite all comments in `modules/` to be blunt one-liners that state the reason only.

**Architecture:** Single editorial pass over 31 `.nix` files grouped by module area. Each task covers one group: read, rewrite, commit.

**Tech Stack:** Nix (comments only, no code changes)

## Global Constraints

- Comments only — no code changes, no behavior changes
- One sentence per comment when possible, max 3 lines (bring-up instructions excepted)
- No history, no cross-references, no explaining Nix primitives
- No comment references another comment or a past event
- Security rationale and bring-up instructions stay (formatted cleanly)
- Delete self-evident comments
- Each commit covers one logical module group

---

### Task 1: devbox (agents.nix, nixos.nix, container.nix)

**Files:**
- Modify: `modules/devbox/agents.nix` (41 comment lines)
- Modify: `modules/devbox/nixos.nix` (29 comment lines)
- Modify: `modules/devbox/container.nix` (4 comment lines + inline comments throughout)

**Principles applied:**
- agents.nix: Header is 38 lines of narrative about direnv behavior. Replace with 3-4 lines: what this file does, why `direnv exec` is used, and the two error paths.
- nixos.nix: Bring-up instructions stay. Cut "same manual ritual used by vikunja-server and local-llm" cross-ref. Cut "flaky on nixos-containers" story — just say "manual join is more reliable." Cut the paragraph about ephemeral pool replacement.
- container.nix: Tighten all inline comments. "they did, and pi died at startup with `Error: spawn bun ENOENT`" → "pi needs bun on PATH or plugins crash." uid paragraph → 2 lines. "same class that bit pi" → delete cross-ref.

- [ ] **Step 1: Read all three files**

Read `modules/devbox/agents.nix`, `modules/devbox/nixos.nix`, `modules/devbox/container.nix` in full.

- [ ] **Step 2: Rewrite agents.nix comments**

Replace the 38-line header with:
```nix
# Agent launchers for the devbox container.
# Paseo spawns agents as child processes, not login shells, so direnv never fires.
# Use `direnv exec .` to load the project devShell before running the agent.
# Fails open if .envrc is blocked (untrusted); warns on flake eval errors.
```
Remove the measured behavior bullet list — the code is self-documenting. Remove "Why the `^error:` check is diagnostic-only" paragraph — just "nix-direnv fails open on broken flakes, so stderr `error:` is a warning only."

Remove the direnv allow-list paragraph (lines about "not allowed is no longer an expected outcome") — it's a cross-reference to container.nix.

- [ ] **Step 3: Rewrite nixos.nix comments**

Keep bring-up instructions as-is. Rewrite header:
```nix
# Persistent coding-agent container. Security boundary: ssh/sops/signing keys
# stay on the host. Repos live in the container filesystem — GitHub holds the code.
```
Replace "Declarative join was tried and removed" with "Manual tailscale join — more reliable than declarative on nspawn containers."
Replace "so a container rebuild rejoins as the same node instead of orphaning one" with "Persist tailscale node identity across rebuilds."
Replace the assertion comment about "miserable thing to debug from a phone" with "Must be FQDN to match paseo Host-header allowlist."

- [ ] **Step 4: Rewrite container.nix comments**

Apply principle examples from the spec:
- piWrapped: 7 lines → 2 lines (spec example)
- uid comment: 12 lines → 2 lines (spec example)
- ghWrapped: "same class that bit pi" → "pkgs.buildEnv fails on duplicate names"
- "same tradeoff DESIGN 6.3 already accepted" → "agent runs arbitrary code by design"
- "Duplicated rather than derived from sessionVariables so both stay in one file and can't silently drift" → "Duplicated from sessionVariables to prevent drift"
- "presents as connects, then 400s" → "mismatch causes 400 errors"
- "an unauthenticated `claude` reading ~/.claude instead of the bind-mounted state dir, with no obvious cause from the phone side" → "unset var makes agents read wrong config"
- Paseo web UI comment: 8 lines → 3 lines

- [ ] **Step 5: Commit**

```bash
git add modules/devbox/
git commit -m "style: tighten devbox comments — blunt reasons only"
```

### Task 2: local-llm (models.nix, llama-swap.nix, weights.nix, nixos.nix, container.nix)

**Files:**
- Modify: `modules/local-llm/models.nix` (13 comment lines)
- Modify: `modules/local-llm/llama-swap.nix` (6 comment lines)
- Modify: `modules/local-llm/weights.nix` (5 comment lines)
- Modify: `modules/local-llm/nixos.nix` (5 comment lines)
- Modify: `modules/local-llm/container.nix` (2 comment lines)

**Principles applied:**
- models.nix: "The one place a model is described" → delete (self-evident from structure). "Consumed by:" list → delete (imports are visible in the other files). "Adding a model:" → one-liner. Inline comments: "measured pool" → "measured on 31GiB card." "net win, keep it" → delete (opinion, not reason). "Prefix caching stays OFF" paragraph → 2 lines.
- llama-swap.nix: "Catalog → llama-swap YAML" is fine. "Per-model entry → lines rather than one template" → one-liner. "ephemeral so the name is cosmetic" → "container name is cosmetic (--rm --replace)."
- nixos.nix: "Gated separately from the driver" → "cuda.enable is separate from nvidia.enable — podman socket is root-equivalent on the host." vLLM image comment: 5 lines → 2 lines.
- Bring-up instructions in nixos.nix header stay as-is.

- [ ] **Step 1: Read all five files**

Read `modules/local-llm/models.nix`, `llama-swap.nix`, `weights.nix`, `nixos.nix`, `container.nix`.

- [ ] **Step 2: Rewrite models.nix comments**

Replace header with:
```nix
# Model catalog. Pure data — no pkgs/config/arguments.
# Add a model: write its attrset, add name to `enabled`, rebuild.
```
Delete the "Consumed by:" list. Tighten inline comments:
- "measured pool: 195,750 tokens at gpu-memory-utilization 0.94" → "measured on 31GiB card; drop maxModelLen if pool shrinks"
- "clients declare maxModelLen - headroom, so a long request is refused up front" → delete (self-evident)
- "The daily driver stays: a vLLM cold start is minutes" → "null ttl: vLLM cold start is minutes"
- "net win, keep it" → delete
- Prefix caching paragraph (8 lines) → "Prefix caching off: caused incoherent rewrite loops on long sessions."
- "Same running instance under a second name" → "Aliases share the running instance — no model swap."

- [ ] **Step 3: Rewrite llama-swap.nix, weights.nix, nixos.nix, container.nix comments**

llama-swap.nix: Replace header with "Model catalog → llama-swap YAML config." Replace "Per-model entry → lines rather than one template, so adding a second backend later..." with "Per-model args so multiple backends can coexist."

weights.nix: Tighten any narrative comments to one-liners.

nixos.nix: "Gated separately from the driver: enabling this bind-mounts the host podman socket into the container, which is root-equivalent access to the host, so flip cuda.enable only once that's acceptable." → "cuda.enable is separate from nvidia.enable — podman socket grants root-equivalent host access."

vLLM image comment: "vLLM runs from upstream's prebuilt OCI image, not nixpkgs: the nix build compiles torch/magma/flash-attn from source (hours of nvcc that OOM 32GB), and nixpkgs lags upstream - NVFP4 quants want >= 0.25 while unstable ships 0.16." → "Use upstream OCI image — nix build OOMs on 32GB and nixpkgs lags upstream."

container.nix: Tighten inline comments.

- [ ] **Step 4: Commit**

```bash
git add modules/local-llm/
git commit -m "style: tighten local-llm comments — blunt reasons only"
```

### Task 3: Servers (stalwart, dns, jellyfin, immich, vikunja, teamspeak, redlib, terraria)

**Files:**
- Modify: `modules/stalwart-server/nixos.nix` (27 comment lines)
- Modify: `modules/dns-server/nixos.nix` (17 comment lines)
- Modify: `modules/jellyfin-server/nixos.nix` (4 comment lines)
- Modify: `modules/immich-server/nixos.nix` (4 comment lines)
- Modify: `modules/vikunja-server/nixos.nix` (4 comment lines)
- Modify: `modules/teamspeak-server/nixos.nix` (5 comment lines)
- Modify: `modules/redlib/nixos.nix` (4 comment lines)
- Modify: `modules/terraria-server/nixos.nix` (2 comment lines)

**Principles applied:**
- stalwart-server: DESIGN paragraph (8 lines) → 2 lines. Bring-up instructions stay. "First login + config" steps stay.
- dns-server: Bring-up instructions stay, format as clean step list. "create an admin password with" → merge into steps.
- All other servers: Bring-up instructions stay. Delete any narrative.

- [ ] **Step 1: Read all eight files**

Read all server module files.

- [ ] **Step 2: Rewrite stalwart-server/nixos.nix**

Replace DESIGN paragraph with:
```nix
# Stalwart mail server container.
# Minimal local config — only boot-critical keys. Everything else is
# database-managed via web UI (certs, domains, accounts, DKIM, spam).
```
Keep bring-up and first-login steps as-is.

- [ ] **Step 3: Rewrite dns-server/nixos.nix**

Replace header with:
```nix
# AdGuard Home + Unbound DNS container.
# Bring-up:
#   sudo nixos-container root-login dns
#   tailscale up --hostname=dns --advertise-tags=tag:solo-node --accept-dns=false
#   tailscale serve --bg 3000
#
# Set admin password:
#   mkpasswd -m bcrypt  # generate hash
#   sudo nixos-container root-login dns && cd /var/lib/AdGuardHome
#   Edit AdGuardHome.yaml users block with the hash
```

- [ ] **Step 4: Rewrite remaining server files**

Each server file has a bring-up header. Keep the commands, delete any prose.

teamspeak-server: Keep bring-up + "Get ServerAdmin token from journalctl" as one-liner.

- [ ] **Step 5: Commit**

```bash
git add modules/stalwart-server/ modules/dns-server/ modules/jellyfin-server/ modules/immich-server/ modules/vikunja-server/ modules/teamspeak-server/ modules/redlib/ modules/terraria-server/
git commit -m "style: tighten server comments — blunt reasons only"
```

### Task 4: Coding agents (pi-coding-agent, opencode, coding-agents)

**Files:**
- Modify: `modules/pi-coding-agent/settings.nix` (8 comment lines)
- Modify: `modules/pi-coding-agent/extra-packages.nix` (11 comment lines)
- Modify: `modules/opencode/settings.nix` (9 comment lines)
- Modify: `modules/coding-agents/container.nix` (6 comment lines)
- Modify: `modules/coding-agents/options.nix` (2 comment lines)

**Principles applied:**
- pi-coding-agent/settings.nix: "Shared pi configuration data. Consumed by home.nix" → "Pi config data, consumed by home.nix." "The redtruck provider's model list... is a one-file edit" → delete (self-evident from import). "Keep every model reference identical" paragraph → 2 lines. "bun instead of npm" paragraph → 1 line.
- pi-coding-agent/extra-packages.nix: Tighten header narrative.
- opencode/settings.nix: "Pure data: opencode config consumed by..." → "Opencode config data." "Aliases are not registered here" → "No aliases — opencode has no tier system." "robin is a different machine" → keep as one-liner.
- coding-agents/container.nix: "Same uid as the host user so bind-mounted project files stay writable" → keep, tighten. "No pi-sandbox in here: the container is the boundary" → keep.

- [ ] **Step 1: Read all five files**

Read all coding agent module files.

- [ ] **Step 2: Rewrite pi-coding-agent/settings.nix**

Replace header with:
```nix
# Pi config data. Model list derived from local-llm/models.nix.
```
"Keep every model reference identical: llama-swap serves one model at a time, so a background task pointed at a different model evicts the loaded one and stalls everything for minutes." → "All models point to the same instance — llama-swap serves one model at a time, so a different model evicts and stalls for minutes."
"bun instead of npm for pi's package installs: pi-superagents ships a postinstall that runs node --experimental-strip-types on a .ts inside node_modules, which node categorically refuses" → "Use bun — node refuses --experimental-strip-types in pi-superagents postinstall."

- [ ] **Step 3: Rewrite pi-coding-agent/extra-packages.nix**

Tighten header to one-liner: "Packages needed on PATH for pi plugins, regardless of project devShell."

- [ ] **Step 4: Rewrite opencode/settings.nix**

Replace header with:
```nix
# Opencode config data. Model list derived from local-llm/models.nix.
# No aliases — opencode has no tier system.
```

- [ ] **Step 5: Rewrite coding-agents/container.nix and options.nix**

container.nix: Tighten "Same uid as the host user so bind-mounted project files stay writable (uids are auto-allocated per host, hence the option), and the same supplementary groups for trees where write access comes from a group rather than ownership" → "Match host uid for writable bind-mounts and group-permissioned shares."

"nixos containers bind the host nix-daemon socket by default, so the daemon sees this uid - i.e. the agent talks to the daemon as a trusted-user. Same exposure the old pi-sandbox config accepted via allowAllUnixSockets." → "Host nix-daemon socket makes the agent a trusted user — same exposure as the old pi-sandbox."

options.nix: Tighten any narrative.

- [ ] **Step 6: Commit**

```bash
git add modules/pi-coding-agent/ modules/opencode/ modules/coding-agents/
git commit -m "style: tighten coding-agent comments — blunt reasons only"
```

### Task 5: Theme, darwin, misc

**Files:**
- Modify: `modules/theme/constants.nix` (4 comment lines)
- Modify: `modules/theme/darwin.nix` (3 comment lines)
- Modify: `modules/theme/shared.nix` (2 comment lines)
- Modify: `modules/home-darwin.nix` (4 comment lines)
- Modify: `modules/homebrew/darwin.nix` (3 comment lines)
- Modify: `modules/hammerspoon/home.nix` (3 comment lines)
- Modify: `modules/firefox/darwin.nix` (2 comment lines)
- Modify: `modules/keybase/darwin.nix` (2 comment lines)
- Modify: `modules/alacritty/linux.nix` (2 comment lines)
- Modify: `modules/system/darwin.nix` (1 comment line)

**Principles applied:**
These files have minimal comments. Tighten any that exist to one-liners. Delete any that are self-evident.

- [ ] **Step 1: Read all ten files**

Read all remaining files with comments.

- [ ] **Step 2: Rewrite comments**

Apply principles: one-liner, state the reason, delete if self-evident.

- [ ] **Step 3: Commit**

```bash
git add modules/theme/ modules/home-darwin.nix modules/homebrew/ modules/hammerspoon/ modules/firefox/darwin.nix modules/keybase/darwin.nix modules/alacritty/linux.nix modules/system/darwin.nix
git commit -m "style: tighten theme/darwin/misc comments — blunt reasons only"
```

### Task 6: Final verification

**Files:** All `.nix` files under `modules/`

- [ ] **Step 1: Check no comment exceeds 3 lines (except bring-up blocks)**

```bash
cd /var/lib/paseo/worktrees/39wgb8ft/relaxed-peacock
# Find multi-line comment blocks > 3 lines
awk '/^#/{c++;next} {c=0} c>3{print FILENAME": "c" lines"}' modules/**/*.nix
```

- [ ] **Step 2: Check for cross-references**

```bash
grep -rn "same.*as\|see.*above\|see.*below\|see.*the.*comment\|DESIGN.*\.\|the same.*that\|same class\|same tradeoff" modules/ --include="*.nix"
```

- [ ] **Step 3: Check for narrative patterns**

```bash
grep -rn "they did\|it happened\|was tried\|used to\|before we\|originally\|replaces the\|replaced the\|fatal for\|miserable thing" modules/ --include="*.nix"
```

- [ ] **Step 4: Verify nix evaluation still works**

```bash
nix flake show --no-update-lockfile 2>&1 | head -20
```

- [ ] **Step 5: Review final diff**

```bash
git diff HEAD~5..HEAD --stat
```

Confirm total comment line reduction is ~30-50%.