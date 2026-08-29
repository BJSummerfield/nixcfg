# Repo-wide Comment Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the repo's comment volume so that every remaining comment answers a "why" the reader cannot derive from the code itself — with zero behavior change, a per-file fact ledger as the audit trail, and one PR of five area-grouped commits.

**Architecture:** One branch (`audit-comments`, already created in this worktree), one PR. Five self-contained commits grouped by module area; each area goes through an extract → edit → audit → verify → commit cycle. "Proof of no value change" is mechanical: the flake's pure-eval checks (`nix flake check`) re-derive every host config and the `devboxes`/`photoform` tests, so any changed attribute value or key fails the build; `nix fmt` cleanness bounds formatting; the final diff is reviewed for comment-only hunks.

**Tech Stack:** Nix (flake, nixfmt-tree formatter), GitHub Actions YAML, shell scripts, plus KDL/TOML/CSS/Lua host config. No new dependencies, no new files except the transient scratch ledgers.

**Spec:** `docs/superpowers/specs/2026-08-29-comment-reduction-design.md`

## Global Constraints

- Depth: **moderate** — educational/narrative comments are deleted, operational "why" comments are compressed in place. Nothing is moved out of code into a notes doc; no new notes file is created from removed material.
- Scope: **code files only.** `*.md` is untouched (separate, later pass) — including `modules/devbox/ENVIRONMENT.md`, which sits inside an in-scope directory but is out of scope.
- Out of scope: `secrets/*.yaml` (sops-encrypted; hand edits are a footgun), `flake.lock`, images, anything untracked (`.direnv/`), and `.git-blame-ignore-revs` (a git mechanism file; it is *appended to* post-merge in Task 6, never comment-edited).
- No numeric targets, no per-file line caps. Length follows the fact.
- **Zero behavior change:** no Nix attribute value, key, or behavior change; no change to host behavior, options, or CI logic of any kind. Comments embedded in multi-line strings (shell scripts passed to systemd units, `postBuild` wrappers, `writeShellScriptBin` bodies): the shell text they sit in is unchanged in behavior, only quieter.
- No formatting-driven changes beyond what `nix fmt` itself does.
- Mechanical checks (must hold after each area commit and on the final tree):
  1. `nix flake check --print-build-logs` passes — includes the `devboxes` and `photoform` pure-eval checks, the proof that no attribute value changed.
  2. `nix fmt` (flake formatter, nixfmt-tree) reports no further changes.
  3. `git diff <BASE>..HEAD` shows only comment deletions/compressions and formatter reflow.
- Fan-out: areas are independent file sets, so tasks may run in parallel waves of **2–3 subagents maximum** (single shared inference server; a wider wave only queues). Default is serial with a review between tasks. If parallel, each subagent works in its own worktree of `audit-comments`; merge the area commits into the branch in task order.
- Execution venue: this worktree (`/var/lib/paseo/worktrees/39wgb8ft/clingy-goose`), branch `audit-comments`; the default branch is `main`. No new worktree needed for serial execution.

## File Structure

Five commit areas (spec's execution structure), each a self-contained, reviewable commit:

| # | Area (commit) | Files (≈ comment lines, triage order) |
|---|---------------|----------------------------------------|
| 1 | `modules/devbox/` | `container.nix` (≈176), `nixos.nix` (≈35), `plugins.nix` (≈34), `agents.nix` (≈8) |
| 2 | `modules/pi-coding-agent/` | `home.nix` (≈53), `settings.nix` (≈52), `extra-packages.nix` (≈1) |
| 3 | `modules/local-llm/` | `models.nix` (≈55), `nixos.nix` (≈31), `llama-swap.nix` (≈12), `container.nix` (≈5), `weights.nix` (≈2) |
| 4 | `tests/` + `.github/` + `ci/` + `flake.nix` | `tests/devboxes.nix` (≈59), `.github/workflows/check.yml` (≈41), `flake.nix` (≈32), `tests/photoform.nix` (≈19), `ci/prune-cache.sh` (≈13), `ci/nix-daemon-creds.sh` (≈10) |
| 5 | the rest | see below |

Area 5 (the rest) file list:

- `hosts/`: `redtruck/default.nix` (≈42), `vps/default.nix` (≈17), `t495/hardware-configuration.nix` (≈10), `redtruck/hardware-configuration.nix` (≈8), `paynefield/hardware-configuration.nix` (≈3), `elitebook/hardware-configuration.nix` (≈3), `mac/default.nix` (≈2), `t495/default.nix` (≈1), `redtruck/filesystems.nix` (≈1)
- other `modules/`: `stalwart-server/nixos.nix` (≈49), `hammerspoon/init.lua` (≈33), `backups/nixos.nix` (≈25), `vikunja-server/nixos.nix` (≈24), `printing/nixos.nix` (≈21), `jellyfin-server/nixos.nix` (≈21), `photoform/nixos.nix` (≈19), `immich-server/nixos.nix` (≈19), `caddy/nixos.nix` (≈18), `dns-server/nixos.nix` (≈14), `system/nixos.nix` (≈11), `teamspeak-server/nixos.nix` (≈10), `firefox/home.nix` (≈10), `theme/shared.nix` (≈9), `photoform/package.nix` (≈9), `paseo-desktop/home.nix` (≈9), `caddy/package.nix` (≈8), `theme/home.nix` (≈7), `openssh/nixos.nix` (≈6), `nvidia/nixos.nix` (≈6), `jellybox/nixos.nix` (≈6), `alacritty/home.nix` (≈6), `users/nixos.nix` (≈5), `terraria-server/nixos.nix` (≈4), `users/darwin.nix` (≈3), `paseo-desktop/darwin.nix` (≈3), `theme/constants.nix` (≈2), `niri/config.kdl` (≈2), `encode_queue/package.nix` (≈2), `docker/nixos.nix` (≈2), `system/darwin.nix` (≈1), `keybase/darwin.nix` (≈1), `home-darwin.nix` (≈1), `homebrew/darwin.nix` (≈1), `hammerspoon/home.nix` (≈1), `firefox/darwin.nix` (≈1), `alacritty/linux.nix` (≈1), `_1password/nixos.nix` (≈1), `_1password/home.nix` (≈1)
- root: `.sops.yaml` (≈10)

Verified no-ops (0 comment lines, checked 2026-08-29 — do not spend time on these):

| File | Why no-op |
|------|-----------|
| `.envrc` | only content is `use flake` |
| `hosts/redtruck/niri.kdl` | no `//` comments |
| `modules/theme/gtk.css` | no `/* */` comments |
| `modules/hyprlax/scenes/pixel-city/parallax.toml` | no `#` comments |
| `.git-blame-ignore-revs` | mechanism file, out of scope (Task 6 appends) |

Line counts are rough grep counts as of 2026-08-29 (they include in-string shell comments) and are for triage ordering only — not targets. Any listed file may turn out to be a no-op (all comments self-evident); a file with nothing to change produces no commit hunks and no ledger entries.

---

## Tasks

### Task 1: Baseline + `modules/devbox/`

**Files:**
- Modify: `modules/devbox/container.nix`, `modules/devbox/nixos.nix`, `modules/devbox/plugins.nix`, `modules/devbox/agents.nix`
- Commit (plan doc): `docs/superpowers/plans/2026-08-29-comment-reduction.md`
- Scratch (untracked, deleted before the area commit): `LEDGER-devbox`

**Interfaces:**
- Consumes: clean worktree on branch `audit-comments`; `BASE` = HEAD at start (recorded in Step 0).
- Produces: devbox-area comments reduced; one commit on `audit-comments`; clean tree for the next task.

**The rule and method (complete; this task's implementer sees only this task):**

A comment survives only if it answers a "why" the reader cannot derive from the
code itself. Depth: moderate — educational/narrative comments are deleted,
operational "why" comments are compressed in place. Nothing is moved into a
notes doc, and no new notes file is created.

**Keep** (compressed to as few lines as the fact needs):
- Security rationale: tokens/keys never landing in the nix store, root-only
  secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store symlinks
  when an agent rewrites `settings.json`, systemd `set -e` swallowing per-repo
  errors in a `script` unit, git refusing to commit with `gpgSign` on and no key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying instead
  of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation, the
  `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition: "join is
  manual — see nixos.nix", "duplicated from sessionVariables to prevent drift".

**Delete:**
- What-the-code-does restatements: file headers/blocks whose opening
  sentence(s) just describe the next line, carrying no fact beyond what the
  filename or the attrset already says.
- Tutorial framing ("This also means…", "So a malformed…"), step-by-step
  walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

**Compress:** keep the fact and the decision; drop the story. Worked example
(`modules/local-llm/models.nix`, `headroom`, 6 lines → 3):

```nix
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Worked deletion (`modules/devbox/container.nix` header, as found):

```nix
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

**Hard limits:**
- No numeric targets, no line caps — length follows the fact.
- Never change an attribute value, key, or behavior; never change host
  behavior, options, or CI logic. Only comment lines change.
- Comments inside multi-line strings (systemd shell scripts, `postBuild`
  wrappers, `writeShellScriptBin` bodies): a `#` line that is a shell comment
  may be deleted/compressed — the script's behavior is unchanged. Before
  deleting a `#` line that sits *inside a string or a YAML block scalar*,
  confirm the consumer is a shell script; if the scalar is non-shell data,
  leave it untouched (that would change the value).
- No formatting-driven changes beyond what `nix fmt` does.

**Method, per file, in order:**
1. **Extract** — read every comment block; write one ledger line per block to
   the scratch file (here: `LEDGER-devbox`):

   ```
   <file>:<line> (as found) — <the non-obvious fact(s)> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

   Line numbers are from the file *as found*; the `@ <new line>` is filled in
   after editing. Example (real, `container.nix` lines 1–2 as found):

   ```
   modules/devbox/container.nix:1 (as found) — self-evident, no fact -> deleted
   modules/devbox/container.nix:2 (as found) — tailnet join/serve are manual, not driven by Nix -> kept compressed @ 1
   ```

2. **Edit** — delete the restatements and narrative, compress the "why"
   comments in place.
3. **Audit** — re-read the edited file against its ledger lines: every
   extracted fact is present (compressed) or marked self-evident. A fact that
   cannot be compressed to fit is a signal to re-check whether it is really
   one fact or several; record the decision in the ledger.

Files whose comments are entirely self-evident become no-ops: no hunks, no
ledger lines, nothing in the commit.

- [ ] **Step 0: Baseline**

```bash
git branch --show-current   # expect: audit-comments
git status --short          # expect only: ?? docs/superpowers/plans/2026-08-29-comment-reduction.md
git rev-parse HEAD          # record the hash as BASE (used by Task 6's diff review)
git add docs/superpowers/plans/2026-08-29-comment-reduction.md
git commit -m "docs: comment-reduction implementation plan"
```

- [ ] **Step 1: Extract** — read every comment block in `modules/devbox/container.nix`, `nixos.nix`, `plugins.nix`, `agents.nix`; write the ledger to `LEDGER-devbox` per the method above.

- [ ] **Step 2: Edit `modules/devbox/container.nix`** per its ledger lines (largest file, ≈176 comment lines; its in-string `postBuild`/systemd shell comments count as comments under the rule).

- [ ] **Step 3: Edit `modules/devbox/nixos.nix` and `modules/devbox/plugins.nix`** per their ledger lines.

- [ ] **Step 4: Edit `modules/devbox/agents.nix`** per its ledger lines.

- [ ] **Step 5: Audit** — re-read all four edited files against `LEDGER-devbox`; every extracted fact is present (compressed) or marked self-evident. Fix the file or the ledger until they agree.

- [ ] **Step 6: Verify**

```bash
nix fmt
git status --short   # if nix fmt reflowed anything beyond your edits, inspect `git diff`, confirm it is formatter reflow only, and accept it (git add -u)
nix fmt && git status --short   # expect: no modified nix files
nix flake check --print-build-logs   # expect: PASS (devboxes + photoform pure-eval checks included)
```

- [ ] **Step 7: Commit**

```bash
git add modules/devbox/container.nix modules/devbox/nixos.nix modules/devbox/plugins.nix modules/devbox/agents.nix
git commit -m "chore(devbox): keep only non-obvious why-comments" -m "$(cat LEDGER-devbox)"
rm LEDGER-devbox
git status --short   # expect: empty
```

---

### Task 2: `modules/pi-coding-agent/`

**Files:**
- Modify: `modules/pi-coding-agent/settings.nix`, `modules/pi-coding-agent/home.nix`, `modules/pi-coding-agent/extra-packages.nix`
- Scratch (untracked, deleted before the area commit): `LEDGER-pi-coding-agent`

**Interfaces:**
- Consumes: clean tree at Task 1's commit (or any prior wave's commits).
- Produces: pi-coding-agent-area comments reduced; one commit on `audit-comments`.

**The rule and method (complete; this task's implementer sees only this task):**

A comment survives only if it answers a "why" the reader cannot derive from the
code itself. Depth: moderate — educational/narrative comments are deleted,
operational "why" comments are compressed in place. Nothing is moved into a
notes doc, and no new notes file is created.

**Keep** (compressed to as few lines as the fact needs):
- Security rationale: tokens/keys never landing in the nix store, root-only
  secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store symlinks
  when an agent rewrites `settings.json`, systemd `set -e` swallowing per-repo
  errors in a `script` unit, git refusing to commit with `gpgSign` on and no key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying instead
  of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation, the
  `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition: "join is
  manual — see nixos.nix", "duplicated from sessionVariables to prevent drift".

**Delete:**
- What-the-code-does restatements: file headers/blocks whose opening
  sentence(s) just describe the next line, carrying no fact beyond what the
  filename or the attrset already says.
- Tutorial framing ("This also means…", "So a malformed…"), step-by-step
  walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

**Compress:** keep the fact and the decision; drop the story. Worked example
(`modules/local-llm/models.nix`, `headroom`, 6 lines → 3):

```nix
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Worked deletion (`modules/devbox/container.nix` header, as found):

```nix
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

**Hard limits:**
- No numeric targets, no line caps — length follows the fact.
- Never change an attribute value, key, or behavior; never change host
  behavior, options, or CI logic. Only comment lines change.
- Comments inside multi-line strings (systemd shell scripts, `postBuild`
  wrappers, `writeShellScriptBin` bodies): a `#` line that is a shell comment
  may be deleted/compressed — the script's behavior is unchanged. Before
  deleting a `#` line that sits *inside a string or a YAML block scalar*,
  confirm the consumer is a shell script; if the scalar is non-shell data,
  leave it untouched (that would change the value).
- No formatting-driven changes beyond what `nix fmt` does.

**Method, per file, in order:**
1. **Extract** — read every comment block; write one ledger line per block to
   the scratch file (here: `LEDGER-pi-coding-agent`):

   ```
   <file>:<line> (as found) — <the non-obvious fact(s)> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

   Line numbers are from the file *as found*; the `@ <new line>` is filled in
   after editing.

2. **Edit** — delete the restatements and narrative, compress the "why"
   comments in place.
3. **Audit** — re-read the edited file against its ledger lines: every
   extracted fact is present (compressed) or marked self-evident. A fact that
   cannot be compressed to fit is a signal to re-check whether it is really
   one fact or several; record the decision in the ledger.

Files whose comments are entirely self-evident become no-ops: no hunks, no
ledger lines, nothing in the commit.

- [ ] **Step 1: Extract** — read every comment block in `modules/pi-coding-agent/settings.nix`, `home.nix`, `extra-packages.nix`; write the ledger to `LEDGER-pi-coding-agent`.

- [ ] **Step 2: Edit `modules/pi-coding-agent/settings.nix`** per its ledger lines (≈52 comment lines; settings.json seeding and drift-prevention cross-references are the keepers to watch for).

- [ ] **Step 3: Edit `modules/pi-coding-agent/home.nix` and `extra-packages.nix`** per their ledger lines.

- [ ] **Step 4: Audit** — re-read all three edited files against `LEDGER-pi-coding-agent`; every extracted fact is present (compressed) or marked self-evident. Fix the file or the ledger until they agree.

- [ ] **Step 5: Verify**

```bash
nix fmt
git status --short   # if nix fmt reflowed anything beyond your edits, inspect `git diff`, confirm it is formatter reflow only, and accept it (git add -u)
nix fmt && git status --short   # expect: no modified nix files
nix flake check --print-build-logs   # expect: PASS
```

- [ ] **Step 6: Commit**

```bash
git add modules/pi-coding-agent/settings.nix modules/pi-coding-agent/home.nix modules/pi-coding-agent/extra-packages.nix
git commit -m "chore(pi-coding-agent): keep only non-obvious why-comments" -m "$(cat LEDGER-pi-coding-agent)"
rm LEDGER-pi-coding-agent
git status --short   # expect: empty
```

---

### Task 3: `modules/local-llm/`

**Files:**
- Modify: `modules/local-llm/models.nix`, `modules/local-llm/nixos.nix`, `modules/local-llm/llama-swap.nix`, `modules/local-llm/container.nix`, `modules/local-llm/weights.nix`
- Scratch (untracked, deleted before the area commit): `LEDGER-local-llm`

**Interfaces:**
- Consumes: clean tree at Task 1's/Task 2's commits.
- Produces: local-llm-area comments reduced; one commit on `audit-comments`.

**The rule and method (complete; this task's implementer sees only this task):**

A comment survives only if it answers a "why" the reader cannot derive from the
code itself. Depth: moderate — educational/narrative comments are deleted,
operational "why" comments are compressed in place. Nothing is moved into a
notes doc, and no new notes file is created.

**Keep** (compressed to as few lines as the fact needs):
- Security rationale: tokens/keys never landing in the nix store, root-only
  secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store symlinks
  when an agent rewrites `settings.json`, systemd `set -e` swallowing per-repo
  errors in a `script` unit, git refusing to commit with `gpgSign` on and no key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying instead
  of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation, the
  `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition: "join is
  manual — see nixos.nix", "duplicated from sessionVariables to prevent drift".

**Delete:**
- What-the-code-does restatements: file headers/blocks whose opening
  sentence(s) just describe the next line, carrying no fact beyond what the
  filename or the attrset already says.
- Tutorial framing ("This also means…", "So a malformed…"), step-by-step
  walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

**Compress:** keep the fact and the decision; drop the story. Worked example
(`modules/local-llm/models.nix`, `headroom`, 6 lines → 3 — this area's own
file):

```nix
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Worked deletion (`modules/devbox/container.nix` header, as found):

```nix
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

**Hard limits:**
- No numeric targets, no line caps — length follows the fact.
- Never change an attribute value, key, or behavior; never change host
  behavior, options, or CI logic. Only comment lines change.
- Comments inside multi-line strings (systemd shell scripts, `postBuild`
  wrappers, `writeShellScriptBin` bodies): a `#` line that is a shell comment
  may be deleted/compressed — the script's behavior is unchanged. Before
  deleting a `#` line that sits *inside a string or a YAML block scalar*,
  confirm the consumer is a shell script; if the scalar is non-shell data,
  leave it untouched (that would change the value).
- No formatting-driven changes beyond what `nix fmt` does.

**Method, per file, in order:**
1. **Extract** — read every comment block; write one ledger line per block to
   the scratch file (here: `LEDGER-local-llm`):

   ```
   <file>:<line> (as found) — <the non-obvious fact(s)> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

   Line numbers are from the file *as found*; the `@ <new line>` is filled in
   after editing.

2. **Edit** — delete the restatements and narrative, compress the "why"
   comments in place.
3. **Audit** — re-read the edited file against its ledger lines: every
   extracted fact is present (compressed) or marked self-evident. A fact that
   cannot be compressed to fit is a signal to re-check whether it is really
   one fact or several; record the decision in the ledger.

Files whose comments are entirely self-evident become no-ops: no hunks, no
ledger lines, nothing in the commit.

- [ ] **Step 1: Extract** — read every comment block in `modules/local-llm/models.nix`, `nixos.nix`, `llama-swap.nix`, `container.nix`, `weights.nix`; write the ledger to `LEDGER-local-llm`.

- [ ] **Step 2: Edit `modules/local-llm/models.nix`** per its ledger lines (≈55 comment lines; the `headroom` and KV-pool sizing blocks are measured facts — compress per the worked example, never delete).

- [ ] **Step 3: Edit `modules/local-llm/nixos.nix` and `llama-swap.nix`** per their ledger lines.

- [ ] **Step 4: Edit `modules/local-llm/container.nix` and `weights.nix`** per their ledger lines.

- [ ] **Step 5: Audit** — re-read all five edited files against `LEDGER-local-llm`; every extracted fact is present (compressed) or marked self-evident. Fix the file or the ledger until they agree.

- [ ] **Step 6: Verify**

```bash
nix fmt
git status --short   # if nix fmt reflowed anything beyond your edits, inspect `git diff`, confirm it is formatter reflow only, and accept it (git add -u)
nix fmt && git status --short   # expect: no modified nix files
nix flake check --print-build-logs   # expect: PASS
```

- [ ] **Step 7: Commit**

```bash
git add modules/local-llm/models.nix modules/local-llm/nixos.nix modules/local-llm/llama-swap.nix modules/local-llm/container.nix modules/local-llm/weights.nix
git commit -m "chore(local-llm): keep only non-obvious why-comments" -m "$(cat LEDGER-local-llm)"
rm LEDGER-local-llm
git status --short   # expect: empty
```

---

### Task 4: `tests/` + `.github/` + `ci/` + `flake.nix`

**Files:**
- Modify: `tests/devboxes.nix`, `tests/photoform.nix`, `.github/workflows/check.yml`, `flake.nix`, `ci/prune-cache.sh`, `ci/nix-daemon-creds.sh`
- Scratch (untracked, deleted before the area commit): `LEDGER-ci-tests`

**Interfaces:**
- Consumes: clean tree at Tasks 1–3's commits.
- Produces: tests/CI-area comments reduced; one commit on `audit-comments`.

**The rule and method (complete; this task's implementer sees only this task):**

A comment survives only if it answers a "why" the reader cannot derive from the
code itself. Depth: moderate — educational/narrative comments are deleted,
operational "why" comments are compressed in place. Nothing is moved into a
notes doc, and no new notes file is created.

**Keep** (compressed to as few lines as the fact needs):
- Security rationale: tokens/keys never landing in the nix store, root-only
  secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store symlinks
  when an agent rewrites `settings.json`, systemd `set -e` swallowing per-repo
  errors in a `script` unit, git refusing to commit with `gpgSign` on and no key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying instead
  of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation, the
  `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition: "join is
  manual — see nixos.nix", "duplicated from sessionVariables to prevent drift".

**Delete:**
- What-the-code-does restatements: file headers/blocks whose opening
  sentence(s) just describe the next line, carrying no fact beyond what the
  filename or the attrset already says.
- Tutorial framing ("This also means…", "So a malformed…"), step-by-step
  walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

**Compress:** keep the fact and the decision; drop the story. Worked example
(`modules/local-llm/models.nix`, `headroom`, 6 lines → 3):

```nix
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Worked deletion (`modules/devbox/container.nix` header, as found):

```nix
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

**Hard limits:**
- No numeric targets, no line caps — length follows the fact.
- Never change an attribute value, key, or behavior; never change host
  behavior, options, or CI logic. Only comment lines change.
- Comments inside multi-line strings (systemd shell scripts, `postBuild`
  wrappers, `writeShellScriptBin` bodies): a `#` line that is a shell comment
  may be deleted/compressed — the script's behavior is unchanged. Before
  deleting a `#` line that sits *inside a string or a YAML block scalar*,
  confirm the consumer is a shell script; if the scalar is non-shell data,
  leave it untouched (that would change the value). In
  `.github/workflows/check.yml`, `#` lines inside `run: |` block scalars are
  shell comments (safe); `#` lines at YAML level are YAML comments (safe as
  comments); anything else is a value — do not touch.
- No formatting-driven changes beyond what `nix fmt` does (`nix fmt` does not
  touch YAML/shell files; the formatter reflow gate applies to the Nix files
  only).

**Method, per file, in order:**
1. **Extract** — read every comment block; write one ledger line per block to
   the scratch file (here: `LEDGER-ci-tests`):

   ```
   <file>:<line> (as found) — <the non-obvious fact(s)> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

   Line numbers are from the file *as found*; the `@ <new line>` is filled in
   after editing.

2. **Edit** — delete the restatements and narrative, compress the "why"
   comments in place.
3. **Audit** — re-read the edited file against its ledger lines: every
   extracted fact is present (compressed) or marked self-evident. A fact that
   cannot be compressed to fit is a signal to re-check whether it is really
   one fact or several; record the decision in the ledger.

Files whose comments are entirely self-evident become no-ops: no hunks, no
ledger lines, nothing in the commit.

- [ ] **Step 1: Extract** — read every comment block in `tests/devboxes.nix`, `tests/photoform.nix`, `.github/workflows/check.yml`, `flake.nix`, `ci/prune-cache.sh`, `ci/nix-daemon-creds.sh`; write the ledger to `LEDGER-ci-tests`.

- [ ] **Step 2: Edit `tests/devboxes.nix`** per its ledger lines (≈59 comment lines; the "why a pure-eval check suffices" rationale is a keeper — compress, don't delete).

- [ ] **Step 3: Edit `.github/workflows/check.yml` and `flake.nix`** per their ledger lines.

- [ ] **Step 4: Edit `tests/photoform.nix`, `ci/prune-cache.sh`, `ci/nix-daemon-creds.sh`** per their ledger lines.

- [ ] **Step 5: Audit** — re-read all six edited files against `LEDGER-ci-tests`; every extracted fact is present (compressed) or marked self-evident. Fix the file or the ledger until they agree.

- [ ] **Step 6: Verify**

```bash
nix fmt
git status --short   # if nix fmt reflowed anything beyond your edits, inspect `git diff`, confirm it is formatter reflow only, and accept it (git add -u)
nix fmt && git status --short   # expect: no modified nix files
nix flake check --print-build-logs   # expect: PASS
```

- [ ] **Step 7: Commit**

```bash
git add tests/devboxes.nix tests/photoform.nix .github/workflows/check.yml flake.nix ci/prune-cache.sh ci/nix-daemon-creds.sh
git commit -m "chore(ci+tests): keep only non-obvious why-comments" -m "$(cat LEDGER-ci-tests)"
rm LEDGER-ci-tests
git status --short   # expect: empty
```

---

### Task 5: The rest (hosts, remaining modules, users, root)

**Files:**
- Modify (hosts/): `hosts/redtruck/default.nix`, `hosts/vps/default.nix`, `hosts/t495/hardware-configuration.nix`, `hosts/redtruck/hardware-configuration.nix`, `hosts/paynefield/hardware-configuration.nix`, `hosts/elitebook/hardware-configuration.nix`, `hosts/mac/default.nix`, `hosts/t495/default.nix`, `hosts/redtruck/filesystems.nix`
- Modify (other modules/): `stalwart-server/nixos.nix`, `hammerspoon/init.lua`, `backups/nixos.nix`, `vikunja-server/nixos.nix`, `printing/nixos.nix`, `jellyfin-server/nixos.nix`, `photoform/nixos.nix`, `immich-server/nixos.nix`, `caddy/nixos.nix`, `dns-server/nixos.nix`, `system/nixos.nix`, `teamspeak-server/nixos.nix`, `firefox/home.nix`, `theme/shared.nix`, `photoform/package.nix`, `paseo-desktop/home.nix`, `caddy/package.nix`, `theme/home.nix`, `openssh/nixos.nix`, `nvidia/nixos.nix`, `jellybox/nixos.nix`, `alacritty/home.nix`, `users/nixos.nix`, `terraria-server/nixos.nix`, `users/darwin.nix`, `paseo-desktop/darwin.nix`, `theme/constants.nix`, `niri/config.kdl`, `encode_queue/package.nix`, `docker/nixos.nix`, `system/darwin.nix`, `keybase/darwin.nix`, `home-darwin.nix`, `homebrew/darwin.nix`, `hammerspoon/home.nix`, `firefox/darwin.nix`, `alacritty/linux.nix`, `_1password/nixos.nix`, `_1password/home.nix`
- Modify (root): `.sops.yaml`
- Scratch (untracked, deleted before the area commit): `LEDGER-rest`

**Interfaces:**
- Consumes: clean tree at Tasks 1–4's commits.
- Produces: the final comment-reduction commit on `audit-comments`; ready for Task 6.

**The rule and method (complete; this task's implementer sees only this task):**

A comment survives only if it answers a "why" the reader cannot derive from the
code itself. Depth: moderate — educational/narrative comments are deleted,
operational "why" comments are compressed in place. Nothing is moved into a
notes doc, and no new notes file is created.

**Keep** (compressed to as few lines as the fact needs):
- Security rationale: tokens/keys never landing in the nix store, root-only
  secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store symlinks
  when an agent rewrites `settings.json`, systemd `set -e` swallowing per-repo
  errors in a `script` unit, git refusing to commit with `gpgSign` on and no key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying instead
  of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation, the
  `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition: "join is
  manual — see nixos.nix", "duplicated from sessionVariables to prevent drift".

**Delete:**
- What-the-code-does restatements: file headers/blocks whose opening
  sentence(s) just describe the next line, carrying no fact beyond what the
  filename or the attrset already says.
- Tutorial framing ("This also means…", "So a malformed…"), step-by-step
  walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

**Compress:** keep the fact and the decision; drop the story. Worked example
(`modules/local-llm/models.nix`, `headroom`, 6 lines → 3):

```nix
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Worked deletion (`modules/devbox/container.nix` header, as found):

```nix
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

**Hard limits:**
- No numeric targets, no line caps — length follows the fact.
- Never change an attribute value, key, or behavior; never change host
  behavior, options, or CI logic. Only comment lines change.
- Comments inside multi-line strings (systemd shell scripts, `postBuild`
  wrappers, `writeShellScriptBin` bodies): a `#` line that is a shell comment
  may be deleted/compressed — the script's behavior is unchanged. Before
  deleting a `#` line that sits *inside a string or a YAML block scalar*,
  confirm the consumer is a shell script; if the scalar is non-shell data,
  leave it untouched (that would change the value).
- `.sops.yaml`: its comments are operational key-management instructions
  (how to create a user key, how to get a host key) — apply the rule like
  anywhere else; compress verbose narrative, keep the commands a reader
  cannot derive.
- `modules/hammerspoon/init.lua`: comment lines start with `--` (Lua); the
  rule applies identically.
- No formatting-driven changes beyond what `nix fmt` does (`nix fmt` covers
  Nix only; leave KDL/TOML/CSS/Lua/YAML formatting as-is).

**Method, per file, in order:**
1. **Extract** — read every comment block; write one ledger line per block to
   the scratch file (here: `LEDGER-rest`):

   ```
   <file>:<line> (as found) — <the non-obvious fact(s)> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

   Line numbers are from the file *as found*; the `@ <new line>` is filled in
   after editing.

2. **Edit** — delete the restatements and narrative, compress the "why"
   comments in place.
3. **Audit** — re-read the edited file against its ledger lines: every
   extracted fact is present (compressed) or marked self-evident. A fact that
   cannot be compressed to fit is a signal to re-check whether it is really
   one fact or several; record the decision in the ledger.

Files whose comments are entirely self-evident become no-ops: no hunks, no
ledger lines, nothing in the commit.

- [ ] **Step 1: Extract — hosts** — read every comment block in the nine `hosts/` files (list above); write the ledger lines to `LEDGER-rest`.

- [ ] **Step 2: Edit the `hosts/` files** per their ledger lines (start with `hosts/redtruck/default.nix`, ≈42 comment lines).

- [ ] **Step 3: Extract + edit the two largest remaining files** — `modules/stalwart-server/nixos.nix` (≈49) and `modules/hammerspoon/init.lua` (≈33): ledger lines, then edits.

- [ ] **Step 4: Edit the mid-size modules** — `backups/nixos.nix` (≈25), `vikunja-server/nixos.nix` (≈24), `printing/nixos.nix` (≈21), `jellyfin-server/nixos.nix` (≈21), `photoform/nixos.nix` (≈19), `immich-server/nixos.nix` (≈19), `caddy/nixos.nix` (≈18), `dns-server/nixos.nix` (≈14), `system/nixos.nix` (≈11), `teamspeak-server/nixos.nix` (≈10), `firefox/home.nix` (≈10): ledger lines, then edits.

- [ ] **Step 5: Edit the small modules and `.sops.yaml`** — `theme/shared.nix` (≈9), `photoform/package.nix` (≈9), `paseo-desktop/home.nix` (≈9), `caddy/package.nix` (≈8), `theme/home.nix` (≈7), `openssh/nixos.nix` (≈6), `nvidia/nixos.nix` (≈6), `jellybox/nixos.nix` (≈6), `alacritty/home.nix` (≈6), `users/nixos.nix` (≈5), `terraria-server/nixos.nix` (≈4), `users/darwin.nix` (≈3), `paseo-desktop/darwin.nix` (≈3), `theme/constants.nix` (≈2), `niri/config.kdl` (≈2), `encode_queue/package.nix` (≈2), `docker/nixos.nix` (≈2), `system/darwin.nix` (≈1), `keybase/darwin.nix` (≈1), `home-darwin.nix` (≈1), `homebrew/darwin.nix` (≈1), `hammerspoon/home.nix` (≈1), `firefox/darwin.nix` (≈1), `alacritty/linux.nix` (≈1), `_1password/nixos.nix` (≈1), `_1password/home.nix` (≈1), `.sops.yaml` (≈10): ledger lines, then edits. (These are mostly 1–9 line comments; several are expected to be no-ops.)

- [ ] **Step 6: Audit** — re-read every edited file against `LEDGER-rest`; every extracted fact is present (compressed) or marked self-evident. Fix the file or the ledger until they agree.

- [ ] **Step 7: Verify**

```bash
nix fmt
git status --short   # if nix fmt reflowed anything beyond your edits, inspect `git diff`, confirm it is formatter reflow only, and accept it (git add -u)
nix fmt && git status --short   # expect: no modified nix files
nix flake check --print-build-logs   # expect: PASS
```

- [ ] **Step 8: Commit**

```bash
git add hosts/ modules/ .sops.yaml
git commit -m "chore(hosts,modules,root): keep only non-obvious why-comments" -m "$(cat LEDGER-rest)"
rm LEDGER-rest
git status --short   # expect: empty
```

(`git add` must cover exactly the files this task modified — check `git status` after `git add` shows nothing from other areas staged and nothing in-scope unstaged.)

---

### Task 6: Final verification, PR, post-merge chore

**Files:**
- Modify (post-merge only): `.git-blame-ignore-revs` (append only)

**Interfaces:**
- Consumes: the five area commits from Tasks 1–5, in order, on `audit-comments`.
- Produces: an open PR on `BJSummerfield/nixcfg` (branch `audit-comments` → `main`); post-merge, the blame-ignore entries.

- [ ] **Step 1: Final-tree verification** (run from the worktree, on the tip of `audit-comments`; `BASE` from Task 1 Step 0)

```bash
git log --oneline BASE..HEAD    # expect exactly 6 commits: docs + 5 areas, in order
nix fmt && git status --short   # expect: clean (nothing to reformat, nothing unstaged)
nix flake check --print-build-logs   # expect: PASS
git diff --stat BASE..HEAD       # expect: exactly the 67 files listed in the plan's File Structure plus the plan doc — no other file
```

Then eyeball the diff for comment-only hunks — the largest three files first:

```bash
git diff -U1 BASE..HEAD -- modules/devbox/container.nix | less
git diff -U1 BASE..HEAD -- .github/workflows/check.yml | less
git diff -U1 BASE..HEAD -- hosts/redtruck/default.nix | less
```

Acceptance: every `-`/`+` line is a comment deletion/compression (Nix `#`, shell `#` in a string, YAML `#`, Lua `--`, KDL `//`), formatter reflow of untouched code, or the new plan doc. **Any changed attribute value, key, option, or CI setting is a failure — fix it before pushing** (the audit trail is the ledger in each commit body).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin audit-comments
gh pr create \
  --title "chore: keep only non-obvious why-comments" \
  --body "Spec: docs/superpowers/specs/2026-08-29-comment-reduction-design.md
Plan: docs/superpowers/plans/2026-08-29-comment-reduction.md

Removes what-the-code-does restatements, tutorial framing, and agent-process
narration; compresses operational 'why' comments in place. Comments only:
no attribute value, key, or behavior changed.

Five commits, one per module area; each commit body carries the per-file fact
ledger (extraction of the non-obvious facts with a keep/delete decision per
comment block) so the diff review has the preservation record alongside.

Verification: nix flake check --print-build-logs PASS (incl. devboxes +
photoform pure-eval checks), nix fmt clean, diff reviewed comment-only."
```

- [ ] **Step 3: Post-merge — blame-ignore** (only after the PR is merged into `main`)

```bash
git checkout main && git pull
git log --format='%H %s' main -6   # the 5 area commits + the docs commit (identify the 5)
```

Append to `.git-blame-ignore-revs`, following the file's existing format (blank line, one comment line describing the change, one hash per line — hashes only, the 5 area commits, not the docs commit):

```

# Comment reduction, 2026-08-29. Comments only, no logic changed.
<hash of Task 1 area commit>
<hash of Task 2 area commit>
<hash of Task 3 area commit>
<hash of Task 4 area commit>
<hash of Task 5 area commit>
```

```bash
git commit -am "chore: blame-ignore the comment-reduction commits"
git push
```

The file exists for exactly this kind of bulk change: post-merge blame on
rewritten comment lines is noise.
