# Repo-wide comment reduction

Date: 2026-08-29
Status: approved design, pending implementation plan

## Problem

Much of this repository's comment volume was written by coding agents in a
tutorial voice: comments explain what code does, narrate the reasoning
process, or restate what the code already says. The result is that the
comments that *do* matter — non-obvious constraints, security rationale,
measured facts, workarounds for flaky behavior — are buried inside
multi-paragraph blocks.

## Goal

Cut the comment volume so that every remaining comment is a "why" the
reader cannot derive from the code itself. No numeric target and no
line-length budget: length follows the fact.

Decisions made during brainstorming:

- Depth: **moderate** — educational/narrative comments are deleted,
  operational "why" comments are compressed in place. Nothing is moved
  out of the code into a separate notes doc.
- Scope: **code files only.** Markdown documentation is untouched
  (separate, later pass).
- No numeric targets, no per-file line caps.
- Method: **fact ledger during editing** (approach 1) — per-file
  extraction of the non-obvious facts before editing, audited before
  committing.

## The rule

A comment survives only if it answers a "why" the reader cannot derive
from the code itself.

### Keep (compressed to as few lines as the fact needs)

- Security rationale: tokens/keys never landing in the nix store,
  root-only secret files, "the container is the boundary" decisions.
- Failure modes the reader would not hit by reading: EROFS on store
  symlinks when an agent rewrites `settings.json`, systemd `set -e`
  swallowing per-repo errors in a `script` unit, git refusing to commit
  when `gpgSign` is on without a key.
- Workarounds for flaky or buggy behavior: manual tailscale join/serve on
  nspawn containers, the `grep -q` password pre-start check, copying
  instead of linking agent-owned files.
- Measured facts with consequences: KV pool sizing and its derivation,
  the `headroom` calculation, model-card thinking-mode constraints.
- Cross-references and disambiguations that prevent a wrong intuition:
  "join is manual — see nixos.nix", "duplicated from sessionVariables to
  prevent drift".

### Delete

- What-the-code-does restatements: file headers and blocks whose
  opening sentence(s) just describe the next line ("NixOS configuration
  for the devbox container", "Model catalog. Pure data"), carrying no
  fact beyond what the filename or the attrset already says.
- Tutorial framing: "This also means…", "So a malformed…",
  step-by-step walkthroughs of third-party source code.
- Agent-process narration and storytelling.
- Explanations of options or attributes whose names already say it.

### Compress

Keep the fact and the decision; drop the story. Example from
`modules/local-llm/models.nix` (`headroom`):

```nix
# Before (6 lines):
# vLLM enforces input + maxTokens <= maxModelLen per request, but pi
# only compacts above contextWindow - reserveTokens (16384 default,
# dist/core/compaction/compaction.js). headroom must therefore be
# >= maxTokens - 16384 plus margin for token-count drift, or there is
# a band (maxModelLen - maxTokens .. compaction threshold) where pi
# sends a request vLLM must 400.

# After (3 lines):
# pi compacts above contextWindow - 16384 reserve, so headroom must be
# >= maxTokens - 16384 plus token-count margin or pi can send a request
# vLLM must 400.
```

Example deletion, from the `modules/devbox/container.nix` header:

```nix
# Before:
# NixOS configuration for the devbox container.   <- self-evident, delete
# Tailnet join and serve are manual — see nixos.nix.  <- non-obvious, keep
```

The rule applies wherever a comment appears, including comments embedded
in multi-line strings (shell scripts passed to systemd units,
`postBuild` wrapper scripts, `writeShellScriptBin` bodies).

## Scope

### In scope

All git-tracked, non-encrypted code files. In practice ~30 files carry
meaningful comments, concentrated in:

- `modules/devbox/` (container.nix, nixos.nix, plugins.nix, agents.nix)
- `modules/pi-coding-agent/` (settings.nix, home.nix, extra-packages.nix)
- `modules/local-llm/` (models.nix, nixos.nix, llama-swap.nix)
- `tests/` (devboxes.nix, photoform.nix)
- `.github/workflows/check.yml`, `ci/*.sh`, `flake.nix`
- the rest: `hosts/`, remaining `modules/` (servers, theme, niri,
  hammerspoon, direnv, ...), `users/`, `modules/theme/gtk.css`,
  `modules/hammerspoon/init.lua`, `modules/niri/config.kdl`,
  `hosts/redtruck/niri.kdl`, `modules/hyprlax/.../parallax.toml`,
  `.envrc`, `.sops.yaml`

Files whose comments are entirely self-evident become no-ops; a file
with nothing to change produces no commit hunks and no ledger entries.

### Out of scope

- `secrets/*.yaml` — sops-encrypted; hand edits are a footgun.
- `*.md` — documentation, separate pass.
- `flake.lock`, images, and anything untracked (`.direnv/`).

## Workflow

Per file:

1. **Extract** — read every comment block; write a ledger, one line per
   block: the non-obvious fact(s) it carries, or `self-evident, no
   fact`. Ledger format:

   ```
   <file>:<line> (as found) — <fact> -> kept compressed @ <new line>
   <file>:<line> (as found) — self-evident, no fact -> deleted
   ```

2. **Edit** — apply the rule: delete the restatements and narrative,
   compress the "why" comments in place. No attribute values, keys, or
   behavior change.
3. **Audit** — re-read the edited file against the ledger: every
   extracted fact is present (compressed) or marked self-evident.
4. **Commit** — the file's ledger goes into the commit body of that
   area's commit, so the diff review has the preservation record
   alongside.

## Execution structure

- One branch, one PR, commits grouped by module area (each commit
  self-contained and reviewable):
  1. `modules/devbox/`
  2. `modules/pi-coding-agent/`
  3. `modules/local-llm/`
  4. `tests/` + `.github/` + `ci/` + `flake.nix`
  5. the rest (hosts, remaining modules, users, css, kdl, lua, toml,
     envrc, sops.yaml)
- The areas are independent files, so execution may fan out across areas
  with 2–3 parallel subagents (shared inference server; no wider).
- Post-merge: append the resulting commit hashes to
  `.git-blame-ignore-revs` — the file exists for exactly this kind of
  bulk change, and post-merge blame on rewritten comment lines is noise.

## Verification

Mechanical (must all hold on the final tree):

- `nix flake check --print-build-logs` passes — includes the
  `devboxes` and `photoform` pure-eval checks, which are the proof that
  no attribute value changed.
- The flake formatter (`nix fmt`, nixfmt-tree driving nixfmt) reports no
  further changes.
- `git diff` against the base shows only comment deletions/compressions
  and formatter reflow — no change to any Nix attribute value, key, or
  behavior. (Comments embedded in multi-line strings count as comment
  changes, not value changes: the shell text they sit in is unchanged
  in behavior, only quieter.)

Knowledge:

- Per-file ledger audit before each commit (step 3 above); a fact that
  cannot be compressed to fit is a signal to re-check whether it is
  really one fact or several, and the decision is recorded in the
  ledger.

Human:

- PR reviewed commit-by-commit, ledgers in the commit bodies.

## Non-goals

- No documentation rewrites (that is the separate docs pass).
- No new notes files or docs created from the removed material.
- No formatting-driven changes beyond what the formatter itself does.
- No changes to host behavior, options, or CI logic of any kind.
