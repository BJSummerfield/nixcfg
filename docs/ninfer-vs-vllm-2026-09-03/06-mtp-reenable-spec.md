# 06 — Implementation spec: re-enable MTP on a SHA-pinned nightly

Scout output. Written 2026-09-04. **This document is the implementation contract** — the
implementer follows it literally and does not re-derive the upstream facts.

Every flag below was verified by reading vLLM source at the pinned SHA
`8a728663c1c3eeace834a95f5654fa653cc1998c` via
`gh api repos/vllm-project/vllm/contents/<path>?ref=<sha>`. File:line citations are at that
SHA and nowhere else. Nothing here was taken from docs, release notes, or memory.

Background: `03-mtp-prefix-cache-correctness.md` (mechanism analysis, M1–M4) and
`05-patch-efficacy.md` (field evidence). Read both before starting.

---

## 0. What this change does, in one paragraph

Move the vLLM image from the `v0.28.0` release tag to a SHA-pinned nightly that contains the
two merged mamba/spec-decode corruption fixes absent from 0.28.0 (**M3** #50729, and #53388),
restore MTP speculative decoding at `num_speculative_tokens = 3`, keep prefix caching and
`--mamba-cache-mode align` exactly as they are, and add two flags that did not exist in the
pre-#156 wiring: `disable_eagle_block_drop: true` (statically avoids **M2**, the unfixed
`drop_eagle_block` hole, by never entering that code path) and `--no-async-scheduling`
(statically avoids **M4**, which is gated on async scheduling AND spec decoding, both of
which MTP would otherwise turn on). No file under `vllm/` is patched. `maxNumSeqs` and
`maxNumBatchedTokens` do not move.

---

## 1. Sequence — rebase first, then edit

**Do the rebase before touching any `.nix` file.** Verified state at the time of writing:

```
$ git rev-parse --abbrev-ref HEAD     # plan-vllm-vs-ninfer-benchmark  (NOT peaceful-eel)
$ git rev-list --left-right --count origin/main...HEAD
4	0
```

The branch is **4 behind, 0 ahead** — it carries no commits of its own, only the untracked
`docs/ninfer-vs-vllm-2026-09-03/` tree. So the rebase is a pure fast-forward and cannot
conflict:

```bash
git -C /var/lib/paseo/worktrees/39wgb8ft/peaceful-eel fetch origin
git -C /var/lib/paseo/worktrees/39wgb8ft/peaceful-eel rebase origin/main   # ff to ff825ef
```

### 1.1 What moved on main, and whether it touches us

The four new commits are `2b90b49` (#159 repo-hygiene plan), `69de814` (#160 lint/format
gate), `500ff35` (#161 flake.nix declares hosts), `ff825ef` (#162 LEDGER walk).

Only one of them touches `modules/local-llm/` at all:

```
$ git diff HEAD origin/main --stat -- modules/local-llm/
 modules/local-llm/container.nix | 1 -
```

That is deadnix removing an unused `pkgs` lambda argument from `container.nix`. **The three
files this change edits — `nixos.nix`, `models.nix`, `vllm-service.nix` — are byte-identical
before and after the rebase** (`git diff HEAD origin/main -- <those three>` is empty). The
before-text in §3 therefore applies unchanged post-rebase. Rebase first anyway, so the commit
lands on top of the lint gate rather than under it.

### 1.2 The lint/format gate (#160) is now a hard CI gate

`flake.nix` on main gains `checks.x86_64-linux = import ./checks { ... }` and
`formatter = nixfmt-tree` (treefmt driving nixfmt, gitignore-aware). `checks/default.nix`
adds three lint checks plus per-host eval checks. CI runs `nix flake check`, so any
mis-formatted `.nix` file fails the build.

Before committing, from the repo root:

```bash
nix fmt                                             # formats in place (nixfmt-tree)
git diff --stat                                     # confirm nix fmt changed nothing of ours
nix build .#checks.x86_64-linux.fmt-check    --no-link
nix build .#checks.x86_64-linux.statix-check --no-link
nix build .#checks.x86_64-linux.deadnix-check --no-link
nix build .#checks.x86_64-linux.nixos-redtruck --no-link   # the eval check for this host
```

`statix` and `deadnix` are also in the devShell (`devshell.nix` on main:
`nixfmt sops statix deadnix`), so `nix develop -c statix check .` works for a fast loop.
`statix.toml` disables exactly one lint repo-wide, `repeated_keys` — nothing we add depends
on that.

**Lint risk assessment for the edits in §3: low.** They are (a) one string literal changed,
(b) one attribute added to a data attrset, (c) one `++ lib.optionals (cond) [ ... ]` clause
in the same shape as the `enablePrefixCaching` clause four lines below it, (d) comment
rewrites. No new `let` bindings, no new lambda arguments, no `with`, no `rec` — so deadnix
has nothing to find and statix has no `manual_inherit`/`useless_parens`/`bool_comparison`
surface. I verified the §3.3 insertion is nixfmt-clean and parses:

```
$ nixfmt --check v2.nix   # CLEAN
$ nix-instantiate --parse v2.nix   # PARSES OK
```

The one thing that *will* trip `fmt-check` if written carelessly: the
`--speculative-config` line in §3.3 is 132 characters. nixfmt does not wrap inside a string
literal, so it passes as written — but do **not** hand-wrap it, and do **not** let an editor
reflow it.

### 1.3 `docs/repo-hygiene/LEDGER.md` — do not update, but know that it goes stale

Checked explicitly. LEDGER is a read-only survey snapshot and this change does not update it.
Two entries are falsified by this work and the implementer should be aware rather than
surprised:

- `LEDGER.md:606` — item 3 of the comment-relocation table: *"`modules/local-llm/models.nix:117-126` | 10 | no-speculativeTokens / MTP paragraph | **in-repo**: consolidate into `modules/local-llm/nixos.nix:45-62`"*. §3.2 rewrites that exact block and it stops being a "no-speculativeTokens" paragraph. The line range shifts.
- `LEDGER.md:718` — cites `models.nix:117-126` and `nixos.nix:49-58` by line number; both move.

`LEDGER.md:216`/`873`/`927` flag `nixos.nix:214`'s `"${pkgs.podman}/bin/podman"` as the
repo's sharpest `lib.getExe'` convergence case. **That is out of scope for this change** —
it is in the `vllm-image-pull` unit we touch conceptually (the image pin feeds it) but not
textually. Leave it alone; folding an unrelated idiom fix into a correctness change makes
the revert in §7 stop being one line.

---

## 2. Current wiring — how a catalog attr becomes a CLI flag

Read before editing. Three files, one direction of flow.

**`modules/local-llm/nixos.nix`** owns the image pin, as a plain `let` binding at line 63:

```nix
  vllmImage = "docker.io/vllm/vllm-openai:v0.28.0";
```

Two consumers, both in this file:

1. `nixos.nix:89-99` passes `vllmImage` into `import ./vllm-service.nix`, where it becomes
   the final positional element of `podmanArgs` (`vllm-service.nix:78`) — i.e. the image the
   container runs.
2. `nixos.nix:203-216`, `systemd.services.vllm-image-pull`, whose `ExecStart` is
   `"${pkgs.podman}/bin/podman pull ${vllmImage}"`. This is the declarative half of the pin:
   the vllm unit itself runs `--pull=never` (`vllm-service.nix:62`), so a bumped tag that has
   not been pulled fails the vllm unit fast rather than downloading 8.7 GB inside its start
   timeout. `vllm-service.nix:116-120` orders the vllm unit `after` this unit.

**Bumping `vllmImage` is therefore sufficient** — the pull unit re-runs on the next
`nixos-rebuild switch` because its `ExecStart` string changed. No second edit is needed, and
nothing outside `nixos.nix` references the tag.

**`modules/local-llm/models.nix`** is pure data. The per-model `vllm = { ... }` attrset
(lines 86-128 for `Qwen3.8-27B-NVFP4`) carries the tuning knobs. Only `catalog.default` is
served (`nixos.nix:129-131` asserts `enabled` has exactly one entry), so an attr present on
one model and absent on another is not a problem in practice — but see §3.3 on why the new
clause is guarded anyway.

**`modules/local-llm/vllm-service.nix`** turns that attrset into flags. `vllmArgs`
(lines 35-59) is a list of one-flag-per-element strings, joined with ` \\\n  ` into a
`writeShellScript` (line 83). It has two parts:

- an unconditional list (lines 36-50), interpolating `m.vllm.*` and `m.sampling.*` directly;
- a `++ lib.optionals (m.vllm.enablePrefixCaching or false) [ ... ]` tail (lines 56-59) that
  contributes `--enable-prefix-caching` and `--mamba-cache-mode align` together.

**Where `speculativeTokens` goes and what generated `--speculative-config`:** pre-#156 the
attr sat in `models.nix`'s `vllm` block between `kvCacheDtype` and `toolCallParser`, and
`vllm-service.nix` emitted it as the *last* element of the unconditional list, immediately
after `--override-generation-config`. That is the shape we restore (§3.3), with the one
change that it becomes a guarded `lib.optionals` clause — because it now carries a second
flag that must never appear without it, and because that guard is what makes §7's rollback
one line.

---

## 3. The edits

Three files. Nothing else. Do not touch `modules/pi-coding-agent/`, `docs/repo-hygiene/`, or
`AGENTS.md`.

### 3.1 `modules/local-llm/nixos.nix` — image pin and the comment above it

Replace lines 45-63 (the comment block starting `# Use upstream OCI image` through the
`vllmImage = ...;` line) in full.

**BEFORE:**

```nix
  # Use upstream OCI image — nix build OOMs on 32GB and nixpkgs lags upstream.
  #
  # v0.28.0 was taken for PR #51113 ("Keep mamba align prefill chunks
  # block-aligned past last_cache_position"), the first tag containing the
  # merged half of the correctness fix for hybrid-Mamba prefix caching combined
  # with MTP speculative decoding. It was not enough: corruption continued
  # (mojibake mid-session, leaked tool-call XML) and MTP is now off in
  # models.nix. The remaining half of that work — vllm#47194, and the CUDA and
  # off-by-one issues split out of vllm#43559 — is still open upstream.
  #
  # MTP re-enable gate: a tag that closes those issues, then A/B it over a long
  # agentic session rather than a one-shot benchmark. That is worth chasing —
  # MTP was measured at 3.04 tokens per decode step on this stack, and the
  # stack is decode-bound.
  #
  # 0.28.0 also turns prefix caching on by default for Mamba models (#50991),
  # which makes our --enable-prefix-caching redundant. It stays explicit: it
  # documents intent and survives a future default flip in either direction.
  vllmImage = "docker.io/vllm/vllm-openai:v0.28.0";
```

**AFTER:**

```nix
  # Use upstream OCI image — nix build OOMs on 32GB and nixpkgs lags upstream.
  #
  # A nightly pinned to a SHA, not a release tag, because the two fixes this
  # stack needs merged after v0.28.0 and there is no v0.28.1: GitHub releases
  # stop at v0.28.0 (2026-08-26) and Docker Hub has no v0.28.1 image. A nightly
  # tag is immutable once pushed, so a SHA pin is as reproducible as a release
  # tag; what it costs is that nothing upstream promises this build was tested
  # beyond CI. Bumping it re-runs vllm-image-pull below on the next switch.
  #
  # What this SHA has that v0.28.0 does not:
  #   #50729 "Fix overlapping state copy race" (merged 2026-08-17) — the mamba
  #     conv-state copy that overlapped its own destination. Corruption counts
  #     upstream went 12/5000 -> 0/5000. This is the most likely cause of the
  #     mojibake that took MTP out in #156, and it is why that image bump to
  #     v0.28.0 did not help: the fix missed the branch point.
  #   #53388 "Support disabling trailing prefix-cache block dropping" (merged
  #     2026-09-01) — adds disable_eagle_block_drop, used in models.nix.
  # v0.28.0 already carried #51113 (write-path chunk alignment) and #46384
  # (partial prefix-cache hit for hybrid models); both are still here.
  #
  # 0.28.0 also turns prefix caching on by default for Mamba models (#50991),
  # which makes our --enable-prefix-caching redundant. It stays explicit: it
  # documents intent and survives a future default flip in either direction.
  #
  # Move back to a release tag the moment one ships with #50729 and #53388 in
  # it. Until then, re-pinning to a newer nightly is a decision, not hygiene:
  # every bump is an untested engine under an agentic workload, and §7 of
  # docs/ninfer-vs-vllm-2026-09-03/06-mtp-reenable-spec.md is the soak that
  # earns it.
  vllmImage = "docker.io/vllm/vllm-openai:nightly-8a728663c1c3eeace834a95f5654fa653cc1998c";
```

Verification of the tag (do not skip — a typo here fails only at pull time):

```
$ curl -s https://hub.docker.com/v2/repositories/vllm/vllm-openai/tags/nightly-8a728663c1c3eeace834a95f5654fa653cc1998c
amd64 digest sha256:c9337b064af164bef487f276ba9b64636f2c0554f48357fa1dc2e001165dc1eb
size 8,680,402,627 bytes, last_pushed 2026-09-04T06:07:25Z
$ gh api repos/vllm-project/vllm/commits/8a728663c1c3eeace834a95f5654fa653cc1998c
committed 2026-09-04T04:25:35Z, "[Bugfix] Reject tokenizer-less Qwen VL processor init (#54886)"
```

### 3.2 `modules/local-llm/models.nix` — three comment blocks and one attr

#### 3.2a Line 16-17, the MTP head file comment

**BEFORE:**

```nix
        # MTP head. Unused while speculative decoding is off (see the vllm
        # block); fetched anyway so re-enabling needs no re-download.
        "model_mtp.safetensors" = "sha256-HYJoqoWs4JOlYePntjudOQ2sHNVakM1VtexQnDydqf4=";
```

**AFTER:**

```nix
        # MTP head, loaded by --speculative-config (see the vllm block). vLLM
        # resolves the draft model to the target's own directory when the
        # speculative config omits `model`, so this file is found at /model
        # alongside the target weights and needs no separate mount or fetch.
        "model_mtp.safetensors" = "sha256-HYJoqoWs4JOlYePntjudOQ2sHNVakM1VtexQnDydqf4=";
```

Source for the claim: `vllm/config/speculative.py:1315-1327` — when `self.model is None` and
`method == "mtp"`, `self.model = self.target_model_config.model_weights or
self.target_model_config.model`, with the inline comment *"use the draft model from the same
model"*. This is why §5 concludes there is no new download.

#### 3.2b Lines 117-127, the MTP / prefix-caching paragraph

This is the block R2 established is factually wrong. Two separate errors: the stated
mechanism, and the "prefix caching is the next thing off" contingency.

**BEFORE:**

```nix
        # No speculativeTokens: MTP is off. Draft-token rollback cannot restore
        # a mamba recurrent snapshot, so MTP combined with prefix caching
        # poisons cached state on this hybrid architecture and corrupts every
        # later request that hits the poisoned prefix - mojibake mid-session,
        # leaked tool-call XML, degeneration in long agentic runs. The
        # re-enable gate is on the image pin in nixos.nix.
        #
        # Prefix caching is kept and is auto-disabled by vLLM for this
        # architecture, hence the explicit opt-in. If corruption outlives the
        # MTP removal, this flag is the next thing off.
        enablePrefixCaching = true;
```

**AFTER:**

```nix
        # MTP, back on after #156 took it off. 3 is what recipes.vllm.ai
        # suggests for this model's MTP head, and it measured 3.04 accepted
        # tokens per decode step here - on a stack that is 93% decode-bound,
        # which is why removing it doubled TPOT from 9.98 ms to 18.72 ms.
        #
        # "Draft-token rollback cannot restore a mamba recurrent snapshot" was
        # the reason given for the removal and it is wrong about vLLM. The real
        # exposure is four distinct upstream defects, all of them gated on
        # speculative decoding being on - prefix caching alone is not exposed
        # to any of them, which is why it stays on unconditionally below and is
        # NOT the next thing to try if corruption returns:
        #   M1 #51113 write-path chunk alignment - merged, in v0.28.0.
        #   M2 the drop_eagle_block read-path hole - NO fix merged; nine
        #      competing open PRs, five of which push the opposite way. We do
        #      not patch it, we route around it: disable_eagle_block_drop in
        #      vllm-service.nix means that code path never executes.
        #   M3 #50729 overlapping conv-state copy - merged after v0.28.0,
        #      present in the pinned nightly. Most likely cause of what we saw.
        #   M4 #51571 async accepted-count race - open. Statically gated on
        #      async scheduling, which MTP switches on by default, which is why
        #      vllm-service.nix passes --no-async-scheduling alongside this.
        # Mechanism detail in docs/ninfer-vs-vllm-2026-09-03/03; field evidence
        # for each patch in 05; the deploy and rollback runbook in 06.
        speculativeTokens = 3;
        # Prefix caching is auto-disabled by vLLM for this hybrid-attention
        # architecture, so the opt-in is explicit. It is the reason prefill is
        # nearly free here - 82.2% of prompt tokens are cache hits - and no
        # upstream mechanism makes it a corruption suspect on its own. If
        # corruption returns, speculativeTokens comes out first and this stays.
        enablePrefixCaching = true;
```

Placement note: `speculativeTokens` goes **between `kvCacheDtype` and `toolCallParser`**,
which is where it lived pre-#156 (`git show 1b12ba9 -- modules/local-llm/models.nix`). The
`enablePrefixCaching = true;` line stays last in the attrset, where it is now.

#### 3.2c Lines 96-108 — `maxNumBatchedTokens`, one sentence appended

`maxNumSeqs` and `maxNumBatchedTokens` **do not change**. But the batched-tokens comment
records a constraint that MTP moves, so add one sentence rather than leaving a stale bound.

**BEFORE** (last paragraph of the `maxNumBatchedTokens` comment, lines 99-101):

```nix
        # prefer lowering maxNumSeqs - same constraint, opposite sign. Must
        # also stay >= the "Setting attention block size to N tokens" startup
        # line to clear the assert `--mamba-cache-mode align` makes.
```

**AFTER:**

```nix
        # prefer lowering maxNumSeqs - same constraint, opposite sign. Must
        # also stay >= the "Setting attention block size to N tokens" startup
        # line to clear the assert `--mamba-cache-mode align` makes. That line
        # tracks speculative depth - measured 1568 at K=0 and 1600 at K=3 on
        # this model - so 4096 clears it either way, but re-read it after any
        # speculativeTokens change rather than assuming.
```

### 3.3 `modules/local-llm/vllm-service.nix` — the two new flags

Insert a new `++ lib.optionals` clause immediately after the closing `]` of the unconditional
`vllmArgs` list (current line 50), i.e. **before** the existing prefix-caching clause.

**BEFORE (lines 47-56):**

```nix
    # So the value a client omits is the one the model card documents, not
    # whatever the repo's generation_config ships.
    "--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
  ]
  # vLLM auto-disables prefix caching for this architecture, so the opt-in is
  # explicit. `align` caches the linear-attention (mamba) state at the same
  # block granularity as the attention KV, and asserts
  # block_size <= max_num_batched_tokens - so maxNumBatchedTokens must stay >=
  # the "Setting attention block size to N tokens" startup line.
  ++ lib.optionals (m.vllm.enablePrefixCaching or false) [
```

**AFTER:**

```nix
    # So the value a client omits is the one the model card documents, not
    # whatever the repo's generation_config ships.
    "--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
  ]
  # MTP. The two extra fields are not tuning, they are the two mechanisms we
  # cannot fix and must route around, and they only make sense together with
  # the draft-token count - hence one clause, so deleting speculativeTokens
  # from models.nix removes all three and is a complete rollback.
  #
  # disable_eagle_block_drop turns off the trailing prefix-cache block drop
  # (#53388, merged 2026-09-01). The drop is where the unfixed M2 hole lives -
  # the mamba branch of the read path ignores its own drop_eagle_block
  # argument - and on this model it also has no group annotated as the draft
  # group, so the coordinator conservatively flags every group including the
  # mamba one, which is the widened-lookup-window case that silently costs
  # reuse. Off, the path is never entered. Upstream states the trade: it can
  # change which draft tokens are proposed, but accepted tokens are still
  # verified by the target model. The one field measurement of it on a
  # sibling model measured acceptance UP (53-56% -> 57-60%), hit tokens up
  # 4800 -> 6400, and warm turns 26% faster.
  #
  # --no-async-scheduling is mandatory. Async scheduling defaults ON, and MTP
  # keeps it on: the auto-disable branch skips any method in EagleModelTypes,
  # and `mtp` is in it. M4 (#51571, open) is statically gated on that flag -
  # reporter measured 16/288 corrupt with it, 0/288 without. The cost is real
  # (async scheduling exists to close GPU gaps between steps) and is accepted.
  ++ lib.optionals (m.vllm ? speculativeTokens) [
    "--speculative-config '{\"method\": \"mtp\", \"num_speculative_tokens\": ${num m.vllm.speculativeTokens}, \"disable_eagle_block_drop\": true}'"
    "--no-async-scheduling"
  ]
  # vLLM auto-disables prefix caching for this architecture, so the opt-in is
  # explicit. `align` caches the linear-attention (mamba) state at the same
  # block granularity as the attention KV, and asserts
  # block_size <= max_num_batched_tokens - so maxNumBatchedTokens must stay >=
  # the "Setting attention block size to N tokens" startup line.
  ++ lib.optionals (m.vllm.enablePrefixCaching or false) [
```

Two deliberate departures from the pre-#156 shape, both justified:

1. **Guarded, not unconditional.** Pre-#156 the `--speculative-config` string was an
   unconditional element of `vllmArgs`, which worked only because `catalog.default` happened
   to be the one model with the attr. `--no-async-scheduling` must never appear without
   `--speculative-config` (it would cost throughput for nothing on a non-MTP model), so the
   two are bound to one guard. `m.vllm ? speculativeTokens` rather than
   `m.vllm.speculativeTokens or 0 != 0` because the attr is deleted, not zeroed, on rollback
   — matching how #156 removed it.
2. **The `disable_eagle_block_drop` field is inside the JSON**, not a separate CLI flag.
   Confirmed: it is a field of the `SpeculativeConfig` dataclass
   (`vllm/config/speculative.py:440`), and `--speculative-config` is parsed with
   `json.loads` into that dataclass (`vllm/engine/arg_utils.py:1659-1662`).

---

## 4. Flag verification — every string, with its source

All paths are relative to the vLLM repo at ref `8a728663c1c3eeace834a95f5654fa653cc1998c`.

| Flag string as emitted | Verified at | Notes |
|---|---|---|
| `--no-async-scheduling` | `vllm/engine/arg_utils.py:1608` registers `"--async-scheduling"` with `**scheduler_kwargs["async_scheduling"]`; `arg_utils.py:352-354` sets `action = argparse.BooleanOptionalAction` for any field whose type hints contain `bool`; `vllm/config/scheduler.py:179` declares `async_scheduling: bool | None = None` | `BooleanOptionalAction` on `--async-scheduling` generates `--no-async-scheduling` as its negation. **This is the exact spelling.** See §4.1 — the default is not what the brief assumed. |
| `--speculative-config '{...}'` | `vllm/engine/arg_utils.py:1659-1662`: `vllm_kwargs["speculative_config"]["type"] = optional_type(json.loads)`, then `add_argument("--speculative-config", "-sc", ...)` | Still a JSON blob, still spelled the same. `-sc` is a valid short form; we use the long one. |
| JSON field `"method": "mtp"` | `vllm/config/speculative.py:387` `method: SpeculativeMethod \| None`; `:56` `"mtp"` is a member of `MTPModelTypes`, which is a member of `EagleModelTypes` (`:69-71`), which is a member of `SpeculativeMethod` (`:72-82`) | Accepted. Note `:1095-1099`: every *other* `*_mtp` alias is deprecated **to** `"mtp"`, so `"mtp"` is the canonical spelling, not a legacy one. |
| JSON field `"num_speculative_tokens": 3` | `vllm/config/speculative.py:381` `num_speculative_tokens: int = Field(default=None, gt=0)` | Accepted. `gt=0`, so 3 is valid. `:1102-1112` warns that `> 1` runs multiple forwards on one MTP layer and "may result in lower acceptance rate" — informational; we measured 3.04 accepted/step at 3. |
| JSON field `"disable_eagle_block_drop": true` | `vllm/config/speculative.py:440` `disable_eagle_block_drop: bool = False`, docstring *"Disable dropping the trailing prefix-cache block for EAGLE-like speculative methods… It does not disable the speculative drafter itself."* | Accepted as a `--speculative-config` field. Effect chain confirmed in §4.2. |
| JSON field `"model"` | **omitted deliberately** | `vllm/config/speculative.py:1315-1327`: with `model is None` and `method == "mtp"`, vLLM sets the draft model to the target's own path. This is how `/model/model_mtp.safetensors` is found. |
| `--mamba-cache-mode align` | `vllm/engine/arg_utils.py:1280`; `vllm/config/cache.py:71` `MambaCacheMode = Literal["all", "align", "none"]`; `:189-197` docstring | **`align` is unaffected by the `all` deprecation.** `vllm/config/cache.py:326-335` is a `field_validator` that warns *only* `if mode == "all"`. Confirmed by reading the validator body, not by inference. |
| `--enable-prefix-caching` | `vllm/engine/arg_utils.py:1247-1253` (registered with an explicit `"default": None`); `arg_utils.py:526` `enable_prefix_caching: bool \| None = None` | Unchanged. Tri-state; passing the bare flag sets True. |
| `--kv-cache-dtype fp8` | `vllm/engine/arg_utils.py:1243` maps `--kv-cache-dtype` to the `cache_dtype` field; `vllm/config/cache.py:39-52` `CacheDType` Literal includes `"fp8"` | Unchanged. |
| `--tool-call-parser qwen3_xml` | `vllm/entrypoints/launchers/cli_args.py:111` `tool_call_parser: str \| None = None`; parser name registered at `vllm/tool_parsers/__init__.py:185-187` (`"qwen3_xml"` → `Qwen3EngineToolParser`) | Valid. **Note the file moved** — `vllm/entrypoints/openai/cli_args.py` is 404 at this SHA; frontend args now live under `vllm/entrypoints/launchers/`. This is a source-layout change only, no CLI change. |
| `--reasoning-parser qwen3` | `vllm/engine/arg_utils.py` (field present); registered at `vllm/reasoning/__init__.py:135-137` (`"qwen3"` → `Qwen3ParserReasoningAdapter`) | Valid. |
| `--enable-auto-tool-choice` | `vllm/entrypoints/launchers/cli_args.py:105` `enable_auto_tool_choice: bool = False`; `:430-432` raises `TypeError` if set without `--tool-call-parser` | Valid; we always pass both. |
| `--model`, `--served-model-name`, `--gpu-memory-utilization`, `--max-model-len`, `--limit-mm-per-prompt`, `--max-num-batched-tokens`, `--max-num-seqs`, `--override-generation-config` | each present exactly once in `vllm/engine/arg_utils.py` | All unchanged, no deprecation. |

**Nothing in the current flag set is renamed, removed, or deprecated at this SHA.**

### 4.1 The async-scheduling default is worse than the brief assumed — read this

The brief said "MTP auto-enables async scheduling". That understates it. At this SHA
(`vllm/config/vllm.py:1270-1319`), when `async_scheduling is None` — which is the state when
neither flag is passed — vLLM walks a chain of `elif` disable-conditions (pooling runner,
non-Eagle spec method, `disable_padded_drafter_batch`, executor unsupported, ROCm DeepEP) and
if none matches, falls through to:

```python
            else:
                self.scheduler_config.async_scheduling = True
```

**Async scheduling is ON by default for everything, MTP or not.** I checked `v0.28.0` and the
identical `else: async_scheduling = True` is there too (`vllm/config/vllm.py:1233-1234` at
that tag). So async scheduling has been on in production on this stack the whole time,
including right now with MTP off.

That is not currently a problem: M4 requires *both* async scheduling and speculative decoding
— the race is on accepted-token counts, and with MTP off there are none
(`03-mtp-prefix-cache-correctness.md:514`; the reporter's arms were 16/288 with async
scheduling, 0/288 without, 0/288 with prefix caching but no MTP). **Which is exactly why
`--no-async-scheduling` belongs in the MTP clause and not in the unconditional list.**
Turning it off globally would cost throughput today for a mechanism that is not reachable
today.

Passing `--no-async-scheduling` sets the field to `False`, which is falsy at
`vllm/config/vllm.py:1239` and not `None` at `:1270`, so both branches are skipped and the
value survives to `get_scheduler_cls()` (`vllm/config/scheduler.py:203-208`), which returns
the synchronous `Scheduler`. **No error is raised** — the explicit-enable branch at `:1239`
that hard-fails incompatibilities is only reached when the value is truthy.

### 4.2 What `disable_eagle_block_drop: true` actually does — traced, not assumed

This is the one flag whose effect is not obvious from its name, and getting it backwards
would be the most expensive mistake available here. The chain:

1. `vllm/config/speculative.py:1856` — `use_eagle_block_drop()` returns
   `self.use_eagle() and not self.disable_eagle_block_drop`. With the field `true` and
   method `mtp`, this is **False**.
2. `vllm/v1/core/sched/scheduler.py:283-289` — `self.use_eagle_block_drop` is set from that,
   and when eagle is on but block drop is off, vLLM logs
   `"EAGLE trailing prefix-cache block dropping is disabled. This is experimental and may
   affect speculative-token acceptance rates."` **Expect this warning on startup; it is the
   confirmation the flag took, not a problem.**
3. `vllm/v1/core/sched/scheduler.py:300` — `use_eagle_block_drop`, *not* `use_eagle`, is what
   gets passed as `use_eagle=` into `KVCacheManager`.
4. `vllm/v1/core/kv_cache_coordinator.py:105-113` — the coordinator builds `eagle_group_ids`
   from groups annotated `is_eagle_group`, then: *"Conservatively fall back to flag all
   groups when no group is flagged"* — `if use_eagle and not self.eagle_group_ids:
   self.eagle_group_ids = set(range(len(kv_cache_groups)))`.
5. `vllm/v1/core/sched/scheduler.py:425-426` — `if self.use_eagle_block_drop:
   last_cache_position = max(last_cache_position - block_size, 0)`, i.e. the actual drop.

With the field `true`, steps 4 and 5 are both no-ops: `eagle_group_ids` stays empty, nothing
is dropped, and the code path containing M2's hole is never entered. That is the "statically
avoid" in the goal statement, and it is genuine — not a patch, not a workaround, just a
branch that does not execute.

**The cost, stated honestly.** The coordinator's comment (`kv_cache_coordinator.py:115-125`)
explains what the drop is for: during chunked prefill with EAGLE, the lookahead token past
the chunk boundary is combined with the final hidden state and written to the KV cache, so
the final chunk token must be excluded from prefix-cache hits to stop a later request
acquiring a slot polluted by it. Disabling the drop means that exclusion does not happen.
Upstream's own framing of the trade (#53388 body) is that it *"does not bypass target-model
verification… may affect speculative-token acceptance rates, but accepted output tokens are
still verified by the target model."*

**Why we take it anyway**, in order of weight:

- The alternative is not "safe" — it is the M2 hole, which has no merged fix, nine competing
  open PRs, and of those, five push in the *opposite* direction from the correctness-flavored
  two (`05-patch-efficacy.md:4.3`).
- On this model class the drop is arguably *worse* than useless: rule 1 for annotating a
  draft group requires `non_causal_multi_token_decode` (Kimi-K3 DSpark only) and rule 2 is
  DeepseekV4-only (`vllm/v1/core/kv_cache_utils.py:2076-2128`), so **no group here is
  annotated** and step 4's fallback flags every group including the mamba one. vLLM added a
  warning for exactly this situation at this SHA
  (`kv_cache_utils.py:2130-2170`, `_warn_if_unannotated_eagle_mamba`): *"A Mamba group cannot
  satisfy the widened lookup window that implies, so prefix-cache reuse across requests will
  be disabled."* Turning the drop off removes that fallback entirely.
- The only field measurement of the option (E5, `05-patch-efficacy.md:96`, jschmied on
  Qwen3.8-Flash-Next, MTP n=3, APC, batch 4096 — the same batch size we run) measured drop
  **off** as better on every axis: warm turn 2.05 s → 1.52 s (−26%), hit tokens 4,800 →
  6,400, acceptance 53-56% → 57-60%, and no corruption in either arm.

**Flagged as unverified:** I did not find, and do not claim, a *first-hand* soak of
`disable_eagle_block_drop: true` on Qwen3.8-27B-NVFP4 specifically. E5 is a sibling model on
different hardware. If §7's soak shows corruption, §7.2 says which knob moves first.

---

## 5. Memory and KV impact

### 5.1 No new download — confirmed

`model_mtp.safetensors` is already in `models.nix`'s `files` set at line 18 with hash
`sha256-HYJoqoWs4JOlYePntjudOQ2sHNVakM1VtexQnDydqf4=`. `weights.nix` builds a `linkFarm` over
every entry in `files` unconditionally, so the blob is already in the store and already
symlinked into the `/model` mount. Nothing in `weights.nix` or `vllm-service.nix` filters on
whether MTP is enabled. Combined with `vllm/config/speculative.py:1315-1327` resolving the
draft model to the target directory, **the file is found at `/model/model_mtp.safetensors`
with zero fetch and zero mount changes.** The `nixos-rebuild` will not re-download anything.

### 5.2 What MTP costs the KV pool

Two costs, one measured, one structural.

**Draft head weights.** One extra transformer block loaded alongside the 21.97 GiB target.
Not separately measurable from config; it shows up in the "model weights take N GiB" startup
line.

**Mamba state slots — `num_spec` extra blocks per request, confirmed in source.**
`vllm/model_executor/layers/mamba/abstract.py:81-85` sets
`num_speculative_blocks = vllm_config.num_speculative_tokens` (0 only under Kimi-K3
RecoverSSM, which is not us). `vllm/v1/kv_cache_interface.py:929-930` then sizes align-mode
mamba as `page_size_bytes * (2 + num_speculative_blocks + num_prefill_checkpoint_blocks)`.
So per request the mamba state goes from `2 + P` pages to `2 + 3 + P` pages — the brief's
"`num_spec+1` slots per sequence" is the right shape; the exact constant is
`1 + num_speculative_blocks` past the running-state slot
(`vllm/v1/worker/mamba_utils.py:1487-1501`, which is the M3 function). `mamba_block_size` is
16 here (from `vllm:cache_config_info`), so these are small pages, and this is a per-request
cost, not per-token.

**Measured, on this stack.** From `01-baseline-vllm.md:377-380`, comparing the last MTP-on
soak (09-01) with the current MTP-off soak (09-03):

| | MTP on (09-01) | MTP off (09-03, now) |
|---|---:|---:|
| `kv_cache_size_tokens` | 197,283 | 211,911 |
| `kv_cache_max_concurrency` | 1.505 | 2.069 |
| `num_gpu_blocks` | 146 | 149 |
| attention `block_size` | 1600 | 1568 |
| `maxNumSeqs` (config) | **2** | **3** |

Read this as an order of magnitude, not a prediction: the two captures differ in
`maxNumSeqs`, `maxModelLen`, vision, and vLLM version as well as MTP, and the doc says so
explicitly. The useful takeaway is **~7% of pool, ~15k tokens** — not 30%.

Projecting: at `maxModelLen = 102400`, a 197k pool gives `kv_cache_max_concurrency ≈ 1.93`.
That is below `maxNumSeqs = 3`, which is *structurally normal here* — vLLM's figure is a
worst-case pool ÷ `maxModelLen`, and our actual turns run 64-68k, so the pool holds ~3.0 of
them (`04-performance-projection.md:264-268`). Do not read `< 3` as a failure.

### 5.3 Startup lines to read, in order

From `journalctl -u vllm -b --no-pager` after the restart:

1. `Loading model weights took N GiB` — expect an increase over the current run; the delta
   is the MTP head.
2. `Setting attention block size to N tokens` — expect **1600**, not the current 1568.
   Measured elsewhere as 1568/1600/1648 at K=0/3/7. Must stay `<= max_num_batched_tokens`
   (4096) for the `align` assert. 4096 clears 1600 with room.
3. `GPU KV cache size: N tokens` — the pool. Expect ~195-200k.
4. `Maximum concurrency for 102400 tokens per request: N.NNx` — expect ~1.9x.
5. `EAGLE trailing prefix-cache block dropping is disabled…` — confirms
   `disable_eagle_block_drop` took (`scheduler.py:284-289`).
6. **Absence** of `Speculative decoding … will be disabled` and absence of
   `Async scheduling … will be disabled` — the second would mean something else disabled it
   for us and the flag was redundant; either way check that no line claims async scheduling
   is *enabled*.
7. Watch for `Speculative decoding (method=mtp) is enabled but no KV cache group could be
   identified as the draft model's…` (`kv_cache_utils.py:2160-2170`). This warning is gated
   on `use_eagle()`, not on block drop, so **it may fire even with our flag set**. If it
   does, it is describing the fallback we have already disabled — verify with the actual hit
   rate in §7.1 rather than reacting to the warning.

**Only read these from a clean start.** The existing comment in `models.nix` records why:
peak-activation profiling measured 1.03 and 3.12 GiB on identical configs minutes apart when
a startup raced another engine's teardown, reporting a pool 40% too small. `systemctl stop
vllm`, wait for it to actually exit, then start.

### 5.4 Fallback if the pool shrinks too far

**Do not change `maxNumSeqs` as part of this commit.** The signal to watch is
`vllm:num_preemptions_total / vllm:request_success_total`: baseline now is 12.5%; the last
MTP-on soak was 99.4%, but that ran `maxNumSeqs = 2` on a smaller pool and a different
version, so it is not a prediction. If preemptions-per-request climbs past ~50% *and* TPOT
fails to improve, the lever is `maxNumSeqs` 3 → 2 as a **separate follow-up commit** with its
own before/after capture. `maxNumBatchedTokens` is the wrong lever in either direction: it
trades against the pool with the opposite sign, and it cannot go below the attention block
size (1600) that the `align` assert requires.

If the engine refuses to start at all for want of memory, that is the §7.3 rollback, not a
tuning problem.

---

## 6. Deploy

```bash
# on redtruck, BEFORE the switch — capture the pre-change baseline
curl -s http://192.168.100.24:5800/metrics > ~/vllm-pre-mtp-$(date -u +%Y%m%dT%H%M%SZ).prom

sudo nixos-rebuild switch --flake .#redtruck
# vllm-image-pull re-runs because ExecStart's string changed; it is Type=exec and
# detaches, so the switch does not block on 8.7 GB.
journalctl -u vllm-image-pull -f          # wait for the pull to finish

sudo systemctl stop vllm
systemctl is-active vllm                  # must report inactive before restarting
sudo systemctl start vllm                 # ~minutes; ExecStartPost gates on /health
journalctl -u vllm -b --no-pager | less   # read the §5.3 lines
```

The vllm unit runs `--pull=never`, so starting it before the pull completes fails fast and
harmlessly. That is the designed behaviour, not a race to avoid.

---

## 7. Verification

### 7.1 The four checks, in priority order

Run against `http://192.168.100.24:5800/metrics` from redtruck. All series are cumulative
since engine start, so let a real agentic session run first — a one-shot benchmark will not
exercise the cache-hit path where the corruption lived (26k-74k input tokens in, never
early).

**(1) MTP is actually live.** These series are absent entirely when MTP is off — that is how
#156's removal was confirmed. Presence is the check.

```bash
curl -s http://192.168.100.24:5800/metrics | grep -E '^vllm:spec_decode'
```

Expect four families (`vllm/v1/spec_decode/metrics.py:229-231,255`):

- `vllm:spec_decode_num_drafts_total`
- `vllm:spec_decode_num_draft_tokens_total`
- `vllm:spec_decode_num_accepted_tokens_total`
- `vllm:spec_decode_num_accepted_tokens_per_pos{position="0|1|2"}`

Acceptance rate = `num_accepted_tokens_total / num_draft_tokens_total`. Baseline from the
09-01 MTP-on soak: **67.9%**. Mean accepted tokens per step =
`num_accepted_tokens_total / num_drafts_total + 1`; baseline **3.04**.

**(2) Prefix caching did not collapse.** This is the false-positive trap
(`05-patch-efficacy.md` N2): several upstream "fixes" stop the corruption only because hybrid
prefix-cache hits drop to exactly zero. A clean soak with a collapsed hit rate has proven
nothing.

```bash
curl -s http://192.168.100.24:5800/metrics \
  | grep -E '^vllm:(prompt_tokens_total|prompt_tokens_cached_total|prefix_cache_(hits|queries)_total)'
```

`prompt_tokens_cached_total / prompt_tokens_total` — **baseline 82.2%** (current MTP-off
soak; the MTP-on soak was 78.0%). Cross-check with
`prefix_cache_hits_total / prefix_cache_queries_total`.

Decision rule, stated in advance so it is not rationalised later:
- **≥ 70%** — caching is live, the result means something.
- **40-70%** — plausible; MTP is known to cost hit rate on this model class (a same-model
  report measured 69.4% no-spec vs 42.5% at MTP k=3). Continue, but record it.
- **< 20%, and especially ~0%** — caching is effectively off. Any absence of corruption is
  meaningless. Treat as a failure and go to §7.3, regardless of how clean the output looks.

**(3) TPOT — the whole point of the change.** Baselines: **9.98 ms** with MTP (09-01),
**18.72 ms** without (09-03, now). Anything not clearly under ~13 ms means MTP is running but
not paying, and the change should be reconsidered even without corruption.

```bash
curl -s http://192.168.100.24:5800/metrics \
  | grep -E '^vllm:time_per_output_token_seconds_(sum|count)'
# mean = sum / count, in seconds
```

Also capture `vllm:num_preemptions_total` and `vllm:request_success_total` for §5.4.

**(4) Pool and block size** — from `vllm:cache_config_info` labels
(`kv_cache_size_tokens`, `kv_cache_max_concurrency`, `block_size`, `num_gpu_blocks`,
`mamba_cache_mode`), or the §5.3 startup lines. Confirm `mamba_cache_mode="align"` and
`enable_prefix_caching="True"` are still what the labels say.

### 7.2 The soak, and what counts as a failure

A one-shot benchmark cannot falsify this. Run a long agentic session — the #156 incidents
were always 26k-74k input tokens in, on the cache-hit path, and twice hit two independent
sessions twelve seconds apart, which is server-side state. Failure signatures, all four of
which are corruption regardless of how clean the metrics look:

- mojibake / U+FFFD inside a thinking block
- leaked or malformed tool-call XML
- degeneration or rewrite loops in long runs
- a clean `stopReason: "stop"` on an empty or truncated turn

Take a `/metrics` snapshot before ending any run you might want to compare — the counters
reset on restart and a finished run cannot be reconstructed.

**If corruption returns**, the order of knobs is fixed and is the opposite of what the old
`models.nix` comment said:

1. `speculativeTokens` out (§7.3) — every one of M1-M4 is gated on speculative decoding.
2. Only then consider `disable_eagle_block_drop: false`, i.e. the drop back on, accepting
   the M2 hole and the reuse fallback. This is a *diagnostic*, not a fix.
3. **Prefix caching is not on this list.** No upstream mechanism makes it a corruption
   suspect on its own, and turning it off is what makes a clean soak meaningless.

### 7.3 Rollback

**One line, and it is complete:** delete `speculativeTokens = 3;` from `models.nix`. Because
both new flags live in a single `lib.optionals (m.vllm ? speculativeTokens)` clause, that one
deletion removes `--speculative-config` *and* `--no-async-scheduling`, leaving the nightly
image serving with prefix caching, `align`, and no speculative decoding — i.e. exactly the
current production behaviour, on a strictly newer engine that additionally contains #50729.
Then `nixos-rebuild switch` and restart vllm.

Prefer that to reverting the image: a nightly with MTP off is a superset of v0.28.0's fixes,
and reverting both at once loses the information about which one mattered.

**Full revert**, if the nightly itself misbehaves (engine will not start, a flag is rejected,
an unrelated regression):

```bash
git revert <this commit>
sudo nixos-rebuild switch --flake .#redtruck && sudo systemctl restart vllm
```

The `v0.28.0` image is still in podman's local storage — nothing prunes it — so the revert
does not re-download 8.7 GB and does not need network.

---

## 8. Things I could not verify — do not guess past these

1. **No first-hand evidence for `disable_eagle_block_drop: true` on Qwen3.8-27B-NVFP4.** The
   only field measurement (E5) is Qwen3.8-Flash-Next on a GB10, posted 2026-09-04, AI-
   assistance disclosed, one reporter. Everything about §4.2's *mechanism* is source-verified;
   its *outcome on our model* is not.
2. **Whether `_warn_if_unannotated_eagle_mamba` fires for us.** It is gated on `use_eagle()`,
   which stays true, so it may log even though we have disabled the fallback it warns about.
   I could not statically determine whether Qwen3.8's MTP layer registers a spec that trips
   rule 1 at `kv_cache_utils.py:2114-2120`. Resolve it empirically with §7.1 check (2).
3. **`use_multi_module_mtp()`** (`speculative.py:1876-1882`) depends on
   `num_nextn_predict_layers` in the draft model's HF config, which I did not read. If it is
   > 1, `num_prefill_lookahead` becomes 3 instead of 1. The `ValueError` this could raise
   (`kv_cache_coordinator.py:126-134`, requires `scheduler_block_size >= num_prefill_lookahead`)
   is gated on `eagle_group_ids` being non-empty, which our flag makes empty, and the block
   size is 1600 anyway — so this is inert either way. Noted so it is not rediscovered as a
   surprise.
4. **The nightly's untested surface.** #54886, the SHA's own tip commit, is
   *"Reject tokenizer-less Qwen VL processor init"* — a Qwen VL processor change, and we run
   a Qwen VL model with vision enabled. I read nothing suggesting it affects us (it adds a
   rejection path for a config we do not have), but it is the closest thing to an unrelated
   risk in this bump and the vision path should get an explicit smoke test: post one image
   and confirm it is described, before trusting the soak.
5. **`prefix_match_unit` is `None`** in our current config, while some upstream reporters on
   this model set `--prefix-match-unit 16`. I did not evaluate whether that matters. It is
   **out of scope for this change** — do not add it here; one variable at a time.
6. **No local `nix flake check` run.** `statix` and `deadnix` are not on this machine's PATH
   outside the devShell; I verified formatting with `nixfmt 1.4.0` and syntax with
   `nix-instantiate --parse` on the constructed §3.3 edit, but the implementer must run the
   §1.2 commands for real before pushing.
