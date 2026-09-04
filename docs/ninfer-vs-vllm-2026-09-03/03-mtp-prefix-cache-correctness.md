# 03 — MTP x prefix-cache correctness: the vLLM mechanism, and whether NInfer has it

Agent R2. Written 2026-09-03. Sources: vLLM upstream issues/PRs read via `gh api` on
2026-09-03; vLLM source read at tag `v0.28.0` (`git describe` = `v0.28.0`, HEAD
`2cf0a6915ce544dc493a0990f2ea38d81601128a`); NInfer source read at
`github.com/Neroued/ninfer` HEAD `a140e7a` (2026-09-03).

Every claim below is one of: **quoted** (path/URL given), **measured** (command given), or
**inferred** (labelled inline). Nothing else.

---

## 0. Verdict first

**Structurally immune** — to the mechanism as stated, and to all three of the four upstream
mechanisms that are about recurrent state entering or leaving a reuse cache. NInfer cannot
produce this failure because it never writes recurrent state for a draft position at all,
and because it has no block-granular state-hash map to mislabel. The code is quoted in §3.

Two things this verdict does **not** cover, stated up front rather than buried:

1. It is a claim about the design as written in source. **Nothing was built or run.** vLLM's
   design was also sound in outline; it failed on implementation details (an overlapping
   memcpy, a pinned buffer permuted before its copy event was awaited). NInfer has no
   independent deployment evidence and its end-to-end prefix tests assert *reuse accounting*,
   not output equivalence between the hit and miss paths (§3.6).
2. The fourth upstream mechanism (a host/device race on accepted-token counts, vLLM #51571 /
   #53919) is an *implementation* race, not a design flaw, and I did not trace NInfer's
   stream synchronisation far enough to certify it absent. NInfer's structure is much less
   exposed (single stream, synchronous round boundary, per-row base revalidation that throws
   — §3.5), but "less exposed" is not "immune" and I am not claiming it.

And the headline correction: **the mechanism recorded in `modules/local-llm/models.nix` is
wrong in its specifics.** "Draft-token rollback cannot restore a mamba recurrent snapshot"
does not describe what vLLM does. vLLM *does* snapshot recurrent state at every verify
position and select by accepted count (§1.2). See §1.6 for what the comment should say, and
§4 for the consequence — the running 0.28.0 image is missing a merged fix that at least one
reporter confirmed resolves this symptom.

---

## 1. The vLLM mechanism, precisely

### 1.1 It is not one bug. It is four, sharing one symptom.

The symptom — mojibake / CJK runs / `!!!!` / leaked `<tool_call>` XML / degenerate loops /
empty content, always on the cache-hit path, `finish_reason` normal, no crash — has at least
four distinct root causes upstream, three of which are still open as of 2026-09-03.

| # | Mechanism | Where | Spec-decode-only? | Status |
|---|---|---|---|---|
| M1 | **Write-path mislabelling.** A prefill chunk ends mid-block, so a mamba slot is published into the prefix cache under a hash asserting a different token count. | `_mamba_block_aligned_split`, `vllm/v1/core/sched/scheduler.py` | **No** — MTP widens the window, does not create it | **Fixed**, PR #51113, merged 2026-08-06, **in v0.28.0** |
| M2 | **Read-path non-dropping.** `MambaManager.find_longest_cache_hit` takes `drop_eagle_block` and ignores it, so the final matched block — which can hold state written across draft positions — stays reachable. | `vllm/v1/core/single_type_kv_cache_manager.py` + `kv_cache_coordinator.py` | **Yes** (gated on `use_eagle`) | **Open** — PRs #43650, #48375 both open |
| M3 | **Overlapping conv-state shift copy.** Spec-decode shifts the conv window within one physical block with overlapping src/dst; parallel loads/stores give no `memmove` ordering, so the shifted window reads partially-overwritten state. | mamba state copy path | **Yes** | **Merged** 2026-08-17 (PR #50729) — **missed the v0.28.0 branch cut; ships in v0.28.1** |
| M4 | **Async accepted-count race.** Accepted-token counts are copied D2H in step N's row order; `_update_states` permutes that same pinned buffer in step N+1 before anything awaits the event, so a request picks up another request's accepted count — i.e. the *wrong* recurrent snapshot is selected. | `vllm/v1/worker/gpu_model_runner.py`, inside `if self.use_async_scheduling` | **Yes** | **Open** — issue #51571, PR #53919 open |

M4 is the only one of the four that is genuinely "rollback restores the wrong recurrent
state", and even it is a data race on the *index*, not an inability to snapshot.

### 1.2 What vLLM actually does on a speculative accept/reject

vLLM **does** snapshot recurrent state per verify position. It allocates
`num_speculative_blocks` extra mamba slots per request and writes one state per position,
then selects the committed one by accepted count.

`vllm/model_executor/layers/mamba/mamba_utils.py:355-366` (v0.28.0):

```python
def get_temporal_copy_spec(
    state: torch.Tensor,
    block_ids: list[int],
    cur_block_idx: int,
    num_accepted_tokens: int,
) -> MambaCopySpec:
    """Return a MambaCopySpec for copying a temporal state slice."""
    src_block_id = block_ids[cur_block_idx + num_accepted_tokens - 1]
```

and the docstring of `MambaStateCopyFunc` at `mamba_utils.py:321`:

```
  num_accepted_tokens: int - number of accepted tokens used to compute the copy offset.
      Range: 1 .. 1 + num_speculative_tokens (inclusive).
```

The Qwen GDN layer takes a `spec_state_indices_tensor` of shape `[batch, num_spec+1]` and a
`num_accepted_tokens` tensor
(`vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py:1290-1302, 1330-1345`).

**So "draft-token rollback cannot restore a mamba recurrent snapshot" is factually wrong for
vLLM.** The snapshots exist. The bugs are (M1) publishing one of them under the wrong label,
(M2) leaving one reachable that should have been dropped, (M3) corrupting the conv half of it
during the shift copy, and (M4) selecting the wrong one under a host/device race.

### 1.3 M1 in the source, and why it is *not* spec-decode-specific

PR #51113's own description states the invariant and the hole
([#51113](https://github.com/vllm-project/vllm/pull/51113)):

> `MambaManager.cache_blocks` hashes block-table slot `p` as the recurrent state at exactly
> `(p + 1) * block_size` tokens. `_mamba_block_aligned_split` only enforced that invariant
> *below* `last_cache_position`, which EAGLE backs off by one block (and zeroes for prompts
> shorter than two mamba blocks). Past that point any chunk end was accepted [...]
> A single request is accidentally safe — its low slots are null blocks [...] which is why
> this only appears under concurrency and was hard to pin down.

Three things follow, and they matter for the decision:

- **The trigger is chunked prefill under concurrency**, not speculation. "Concurrent prefills
  share the token budget; one request's chunk ends mid-block."
- **EAGLE/MTP only widens the exposed window.** With `use_eagle` the window
  `[last_cache_position, prefill_end]` has size `(P mod block_size) + block_size`; without it,
  `P mod block_size`. Non-zero either way. The PR also fixes a second hole that was never
  eagle-gated at all: an unaligned *start* ("a prefill resuming off-grid — finer
  `prefix_match_unit`, or unaligned externally computed tokens from a KV connector").
- **It is fixed in v0.28.0.** The fixed gate is present at
  `vllm/v1/core/sched/scheduler.py:366-415`, with the invariant now in the comment:

```python
        # Invariant: slot p holds the state after exactly (p + 1) * block_size
        # tokens. State is written at chunk ends, so chunk ends must be block
        # aligned. Exempt: the prompt's last chunk, whose slot decode advances
        # to the boundary. A block too wide for one chunk advances sub-block
        # and re-aligns at the next boundary.
        if end < prefill_end:
```

The eagle back-off is still there and still costs a block
(`scheduler.py:392-394`: `if self.use_eagle: last_cache_position = max(last_cache_position - block_size, 0)`),
which is a *hit-rate* cost, not a correctness one — that is what open PR #53479 and open issues
#53670 / #53504 are about.

Corroboration that M1 is real and was fixed before 0.28.0: @amittell on #43559, 2026-07-26,
reproduced deterministic positional corruption on 0.24.0 and found **"The A -> B -> A poisoning
is fixed in 0.26."** on the identical probe.

### 1.4 M2 in the v0.28.0 source — still live, and spec-decode-gated

`vllm/v1/core/kv_cache_coordinator.py:811-836` (v0.28.0):

```python
                drop_eagle_block = use_eagle and idx not in eagle_verified
                ...
                # Eagle matches one extra drop unit (one hash unit for
                # fine-grained managers, else one cache block) and then drops
                # it, landing back at the candidate length. No margin for
                # mamba: its finder never drops (draft models have no mamba
                # layers), so the hit would grow past the candidate.
                if drop_eagle_block and not isinstance(spec, MambaSpec):
```

And `MambaManager.find_longest_cache_hit` at
`vllm/v1/core/single_type_kv_cache_manager.py:1295-1310` accepts `drop_eagle_block` in its
signature and **never references it again in the body** (verified: `awk 'NR>=1290 && NR<=1420
&& /drop_eagle_block/'` returns only the parameter declaration). So on v0.28.0 the caller
declines to apply the margin *because* the finder never drops, and the finder never drops —
the two halves each assume the other handles it. Note `drop_eagle_block` is `use_eagle and ...`,
so **with MTP off this branch is inert.**

### 1.5 M3 — the one the running image is missing

Verified absent from the running version:

```
$ git -C /tmp/r2/vllm028 log v0.28.0 --oneline --grep="50729\|overlapping state copy"
(no output)
```

@erdholion on [#53912](https://github.com/vllm-project/vllm/issues/53912), 2026-08-28:

> #50729 ("[Bugfix][Mamba] Fix overlapping state copy race", member-authored, merged to main
> Aug 17) **missed the 0.28.0 branch cut**, so v0.28.0 does not contain it. Neither does
> v0.27.1. That fix addresses a speculative-decode **conv-state shift copying within the same
> physical block with overlapping source/destination ranges** — parallel memcpy-style
> loads/stores give no memmove ordering, so the shifted window can read partially-overwritten
> state. [...] it would naturally correlate with prefix-cache hit rate (hits are what re-enter
> conv state mid-stream).

And two days later, @ionut-anghelina on the same thread, 2026-08-28:

> I managed to check fix #50729 and it solves the issue.

@erdholion confirms `a02cfccb` is an ancestor of `v0.28.1rc0`.

### 1.6 What `models.nix` should say instead

Replacement for the mechanism sentence, if that comment is ever edited (out of scope for this
study — R2 touched nothing under `modules/`):

> MTP is off. On this hybrid architecture, speculative decoding writes recurrent state across
> draft positions and interacts with prefix-cache publication in at least four upstream
> defects; the one fixed in 0.28.0 (#51113) is the *write-path* chunk-alignment half, and the
> remaining three (#43650/#48375 read-path block-dropping, #50729 conv-state copy race,
> #51571/#53919 async accepted-count race) are either open or shipped only in 0.28.1. All
> three are gated on speculative decoding, so prefix caching alone is not exposed.

---

## 2. Upstream issue status table (verified 2026-09-03 via `gh api`)

| # | Title (abbrev.) | Type | State | Dates | What it actually is |
|---|---|---|---|---|---|
| [#47194](https://github.com/vllm-project/vllm/issues/47194) | Qwen3.6 hybrid + prefix caching + MTP3 causes tool-call leakage and needle-recall failure | issue | **OPEN** | created 2026-06-30, last updated 2026-08-31 | The report closest to our symptom. 2x RTX 2080Ti, GPTQ, `qwen3_coder` parser, fp8_e5m2 KV, MTP3. No-MTP path clean at 90-98% hit rate; MTP3 path: tool call 2/10, multicase 1/18, needle recall 0/10, multi-turn tool 0/5, `<tool_call>` leaks as plain text. **Never triaged to a root cause; no maintainer response in 6 comments.** |
| [#43559](https://github.com/vllm-project/vllm/issues/43559) | Accuracy drops ~20% with `--enable-prefix-caching` + MTP | issue | closed **completed** 2026-08-06T17:21:01Z | created 2026-05-25, 39 comments | Closed **one second after** #51113 merged (17:21:00Z), i.e. auto-closed by the merge. The thread's last human comment predates the fix by two days, so **the closure carries no post-fix verification.** #51113's own body says "This PR does not close #43559 on its own." |
| [#51113](https://github.com/vllm-project/vllm/pull/51113) | Keep mamba align prefill chunks block-aligned past `last_cache_position` | PR | **MERGED** 2026-08-06 | +258/-11, 2 files | M1. Re-derivation of the stale #45477 / #47861. Ships in v0.28.0. Audit on real gsm8k traffic: 1 poisoned entry published on `main`, 0 with the patch. Its own gsm8k accuracy matrix (0.814 / 0.814 / 0.804 / 0.802 at n=500, 1σ ±1.7) "neither confirms nor refutes an end-to-end effect and I am not claiming an accuracy delta from it." |
| [#47861](https://github.com/vllm-project/vllm/pull/47861) | Fix MTP prefix cache correctness for hybrid Mamba models | PR | closed **UNMERGED** 2026-07-19 | `needs-rebase` | Independent same-root-cause fix; died on conflicts. Credited as co-author on #51113. Its coordinator half (`supports_eagle_cache_peek`, false for `MambaSpec`) was *not* carried forward — that is M2, still open. |
| [#50991](https://github.com/vllm-project/vllm/pull/50991) | [Mamba] enable prefix cache by default | PR | **MERGED** 2026-08-04 | +30/-36 | Turned prefix caching on by default for hybrid models and made `align` the default mode. Empty test plan and empty test result. Merged the same day it was opened. This is why our stack needs an explicit `enablePrefixCaching` opt-in note — and it is the change that put the whole fleet on this path. |
| [#53912](https://github.com/vllm-project/vllm/issues/53912) | prefix caching + MTP **still corrupts output on hybrid Mamba/GDN in v0.28.0** (#43559 closed but unfixed) | issue | **OPEN** | created 2026-08-26, last updated 2026-09-02 | The live thread. H100, Qwen3.5-class 27B FP8, MTP k=2: 4/495 malformed on 0.28.0. Contains the M2, M3 and M4 diagnoses and the confirmations. |
| [#43650](https://github.com/vllm-project/vllm/pull/43650) / [#48375](https://github.com/vllm-project/vllm/pull/48375) | Honor `drop_eagle_block` in `MambaManager` | PRs | **both OPEN** | — | M2. #53912 reports #43650 applied on top of 0.28.0 starts cleanly, no regression; other users report "18/39 → 39/39". |
| [#50729](https://github.com/vllm-project/vllm/pull/50729) | [Bugfix][Mamba] Fix overlapping state copy race | PR | **MERGED** 2026-08-17 | — | M3. **Not in v0.28.0** (verified by `git log v0.28.0 --grep`). Ships in v0.28.1. One reporter confirms it resolves the symptom. |
| [#51571](https://github.com/vllm-project/vllm/issues/51571) / [#53919](https://github.com/vllm-project/vllm/pull/53919) | Async MTP align mode reads accepted counts from mutable InputBatch rows / Await the accepted-token copy before moving batch rows | issue + PR | **both OPEN** | — | M4. Statically gated on `use_async_scheduling`. Reporter: 16/288 with async scheduling, 0/288 without, 0/288 with prefix caching but no MTP. |
| [#47087](https://github.com/vllm-project/vllm/issues/47087) | Native MTP degenerates into garbage token loops on deep agentic conversations | issue | closed 2026-08-19 | — | Qwen3.6-35B-A3B, MTP k=2/3, `max_tokens=20000`. Cited in our `models.nix`. Closed without a stated fix in the body. |

### 2.1 Efficacy of the 0.28.0 fix — the evidence is contradictory, and I am not resolving it

Both of these are on the record, on our exact model class:

- **Negative (fix worked).** @gjc1202 on #47194, 2026-08-26: dual RTX 3090, **Qwen3.8-27B W8A16
  hybrid GDN/Mamba**, vLLM 0.28.0, MTP k=3 + prefix caching + fp8 KV + `mamba-cache-mode align`,
  three-arm greedy A/B/C: needle recall 100%/100%/100%, 200 tool calls with 0 violations, no
  drift. Concludes "after #51113 (c56f169) shipped in 0.28.0, MTP + prefix cache co-enabled
  shows no silent quality degradation." Also @rdlh on #53912, 2026-09-02: 12/5000 corrupted on
  0.27.1, **0/5000 on 0.28.1rc1 nightly**, same flags and prompts.
- **Positive (still broken).** #53912 itself: 4/495 malformed **on 0.28.0**. @karls0r,
  2026-08-31: Qwen3.8-27B INT8, 2x3090 TP=2, fp8 KV, `--max-num-seqs 4` — a sustained hour-long
  window where *every* cache-hit request returned endless CJK or empty, including a trivially
  short "reply with just OK". And our own four incidents on 2026-09-02, on 0.28.0.

The 0.28.0-still-broken reports are consistent with M3 (merged, absent from 0.28.0) and M4
(open); the "fixed" reports are consistent with the reporter's box not hitting those two
(gjc1202 ran two-request-class greedy traffic, and #53919's own repro notes the race is
invisible on an idle box). **Inference, labelled as such:** M3's absence from 0.28.0 is the
single most likely explanation of our 2026-09-02 incidents, and v0.28.1 is a cheap test of
that. This is not established; it is the hypothesis the evidence best supports.

### 2.2 A confound in our own evidence that should be named

Commit `1b12ba9` changed **two** things at once: it removed MTP *and* switched
`toolCallParser` from `qwen3_coder` to `qwen3_xml`. Our own comment in `models.nix:112-114`
says `qwen3_coder` "emits unbounded garbage on long inputs containing a tool call." Our
observed failure was mojibake at 26k-74k input tokens on tool-heavy agent traffic. Upstream
#47194's reporter also ran `qwen3_coder`. **A post-#156 clean soak therefore does not
attribute: it cannot distinguish "MTP removal fixed it" from "the parser swap fixed it."** If
the goal is to get MTP back, that ambiguity is worth ~one afternoon to resolve, because if the
parser was the cause then MTP costs nothing to re-enable.

---

## 3. NInfer's design against that mechanism

Read at `github.com/Neroued/ninfer` HEAD `a140e7a`. Qwen3.8-27B is served by the `qwen3_6_27b`
target — `src/targets/qwen3_6_27b/export/ninfer/targets/qwen3_6_27b/package.h:84-85`:
`qwen3_8_model_id = "qwen3.8-27b"`, `qwen3_8_target_key = "qwen3_8_27b"` — so everything below
applies to our model.

### 3.1 It rejected the snapshot-per-position design outright, and says why

`docs/maintainer/replayssm-gdn.md` is a 642-line design document devoted to exactly this
problem. It names the snapshot approach vLLM uses and discards it on capacity grounds
(§1.2-1.3): a full recurrent state image for Qwen3.6-27B is **144 MiB** (48 GDN layers x 48
value heads x 128x128 FP32), so a per-verify-position snapshot trajectory costs `T x 146.8 MiB`.
Instead it keeps **one committed checkpoint plus a short raw transition log**, at 1.705 MiB per
position — an 86.1x reduction.

The correctness requirement it sets for itself (§1, emphasis original):

> Replay fold 必须执行与 verify recurrence 相同的有限精度状态转移，而不仅是在实数域中计算一个等价公式。
>
> *(The replay fold must execute the same finite-precision state transition as the verify
> recurrence, not merely compute an algebraically equivalent formula in the reals.)*

And §4.4 is a derivation of exactly the drift-propagation failure that vLLM's M3 produces in
practice — "本轮已由 verify trajectory 产生的 outputs 不会被 fold 追溯修改。真正的问题出现在下一轮"
("outputs already produced by this round's verify trajectory are not retroactively modified by
the fold; the real problem shows up in the *next* round"). This is a codebase that understood
the hazard before implementing.

### 3.2 Verify writes no state at all — this is the whole answer to the rollback half

`include/ninfer/ops/gated_delta_net.h`, the op contract for the verify pass:

```
 * Op: gated_delta_net_replay_record
 *
 * Evaluates B independent normalized Gated DeltaNet recurrences from absolute state-pool slots
 * without modifying any state.
```

The call site is the Verify phase of the model traversal,
`src/targets/qwen3_6/impl/runtime/text_context_impl.h:958-963`:

```cpp
        if (gdn_state_action_ == GdnStateAction::RecordForReplay) {
            GdnReplayRecordLayer records = replay_records_->layer(gidx, active_sequence_batch_);
            ops::gated_delta_net_replay_record(q_batch, k_batch, v_batch, g_batch, beta_batch,
                                               kGdnScale, recurrent_states, valid,
                                               *active_linear_state_source_slots_, records.key,
                                               records.value, records.gate, out_batch, s);
        } else {
            ops::gated_delta_net_batch_update(..., *active_linear_state_source_slots_,
                                              *active_linear_state_destination_slots_, ...);
```

Note the asymmetry: the record branch is passed only `source_state_slots`. There is no
destination. The same asymmetry holds for the convolution half at lines 915-928
(`gdn_input_projection_record` takes source slots and a `records.conv` plane;
`gdn_input_projection_snapshot` takes source *and* destination).

**Consequence: there is no such thing, in NInfer, as recurrent or conv state written for a
draft position.** vLLM's M2 hazard — "the final matched block, which can hold recurrent state
written over draft positions that verification later rejected, stays reachable through the
prefix cache" — has no referent here. There is nothing to leave reachable.

### 3.3 Rollback is `commit_columns = 0`, and it is a strict no-op

`include/ninfer/ops/gdn_replay.h`:

```
 * Replays each row's [0,commit_columns) record prefix across every registered GDN layer and
 * updates the caller-selected absolute linear-attention destination state slot. [...]
 * commit_columns is in [0,T]. Zero is a
 * strict no-op for the row: no record or state is read and neither recurrent state nor convolution
 * history is written. For a positive extent, the Op consumes raw key/value/{g,beta} records in
 * order, writes the final FP32 recurrent state, and sets convolution history to
 * tail_3(old_history || conv_record[0:commit_columns]).
```

The commit path, `src/targets/qwen3_6/impl/runtime/program_impl.h:10054-10061`:

```cpp
        const std::uint32_t committed = cancelled[row] ? 0U : accepted_tokens[row];
        ...
        const StateImageSelectors selectors = state_selectors(sequence);
        fold_rows[row] =
            ops::GdnReplayFoldRow{.source_state_slot      = selectors.source,
                                  .destination_state_slot = selectors.destination,
                                  .commit_columns         = static_cast<std::int32_t>(committed)};
```

The rejected suffix `R_{m+1:T}` is never read. Not "restored from a snapshot" — never read.

### 3.4 Verify and fold share the transition function verbatim, at the source level

This is the part that makes the design's own stated requirement (§3.1) hold structurally
rather than by discipline. Both kernels are the same recurrence templated over an *effects*
policy that controls only what is stored, never the arithmetic.
`src/ops/linear_attention/gated_delta_net/recurrent.cuh`:

```cpp
__device__ __forceinline__ void apply_gdn_transition(float (&state)[kDvPerWarp][kQkPerLane],
                                                     const float (&key)[kQkPerLane], float v_local,
                                                     float g, float beta) {
    const float alpha = expf(g);
    for (int r = 0; r < kDvPerWarp; ++r) {
        float partial = 0.0f;
        for (int c = 0; c < kQkPerLane; ++c) { partial += state[r][c] * key[c]; }
        partial = warp_sum<kWarpSize>(partial);
        const float v_r   = __shfl_sync(0xffffffff, v_local, r, kWarpSize);
        const float delta = beta * (v_r - alpha * partial);
        for (int c = 0; c < kQkPerLane; ++c) { state[r][c] = alpha * state[r][c] + delta * key[c]; }
    }
}
```

`RecordEffects` (recurrent.cuh:187) stores key/value/gate records and publishes the output
readout; `FoldEffects` (recurrent.cuh:211) does neither — all three of its hooks are empty
bodies. `kDvPerWarp = 4`, `kQkPerLane = kStateDim / kWarpSize = 4` and `kWarpSize` are
file-scope `inline constexpr` (recurrent.cuh:13-19), so the `warp_sum` reduction tree is
compile-time identical between the two kernels. The `FoldGeometry48x48` / `FoldGeometry30x32`
template parameters (recurrent.cu:190-207) select layer/head counts for launch configuration
only; they do not enter the per-transition arithmetic.

**Inference, labelled:** this makes fold-vs-verify bitwise state equality a property of shared
code rather than of two implementations agreeing. It is the strongest form of the guarantee the
design doc asks for. It is not *proven* bitwise by a test that runs both ops against each other
— see §3.6.

### 3.5 The prefix cache stores whole immutable StateImages at exact frontiers, not hashed blocks

This is the structural difference from vLLM, and it removes M1 by construction.

`docs/maintainer/resource-scheduling-and-context-cache.md` §4.1:

> 当前 model targets 同时包含可分页 Full Attention KV 和**不能从任意较晚状态无损回退的 recurrent
> state**。因此某个 frontier 可以复用，当且仅当 Program 能证明：
> 1. 存在该 frontier 的完整 StateImage；
> 2. Main KV 满足 target 定义的 typed coverage；
> 3. selected backend 的 KV 与 fixed state 满足同一 continuation；
> 4. token、position、Vision 和 mode identity 与 incoming prompt 精确一致。
>
> 只有 token match、KV bytes 或 page match 时，**缺少的是完整 continuation，不是一次部分 cache hit**。

*(The current model targets contain both pageable full-attention KV and recurrent state that
cannot be losslessly rolled back from an arbitrary later state. A frontier is reusable iff the
Program can prove: a complete StateImage for that frontier exists; Main KV satisfies the
target's typed coverage; the selected backend's KV and fixed state satisfy the same
continuation; and token / position / Vision / mode identity match the incoming prompt exactly.
When only tokens, KV bytes or pages match, what is missing is a complete continuation — it is
not a partial cache hit.)*

Reinforced by invariant 6 (§12): "Prefix hit 必须具有 exact identity、完整 StateImage 和全部
required typed KV coverage", invariant 7: "Published checkpoint immutable；每条 active
continuation 至多一个 mutable writer", and §4.5: "Session key、marker、hash 和 prefix index
只缩小 candidate 集合，**不证明命中**" — hashes are a shortlist, never proof of a hit.

The same separation is enforced in code. `src/targets/qwen3_6/impl/runtime/prefix_identity.h`:

```cpp
// One rolling digest per token frontier. This is only a content shortlist: exact token and
// ResidentPrefixIdentity comparison remains authoritative for reuse. Keeping it separate from the
// exact identity avoids retaining hash-only state in immutable capture backings.
class PrefixShortlistDigests {
```

The StateImage itself is the complete continuation state — `linear_conv`, `linear_recurrent`,
`continuation_hidden`, optional `dflash_local_k/v`
(`src/targets/qwen3_6/export/ninfer/targets/qwen3_6/state_image.h:33-45`), moved as one unit
("StateImage 是完整迁移单位", §5.1).

**vLLM's M1 hazard is "slot p is hashed as `state@1600` but holds `state@364`".** NInfer has no
`state@N` hash. It has one StateImage per published checkpoint, bound to that checkpoint's
exact token frontier, immutable after publication, and reuse requires re-verifying the token
IDs, token types, MRoPE axes, vision spans and mode against the incoming prompt. **A slot
cannot be mislabelled because slots are not labels.**

On the round boundary and M4-adjacent exposure: `docs/maintainer/engine-architecture.md:365-367`
— "Engine 对每行输出进行 Frontend preview，形成 accepted-prefix decision，再用一次
`Program::commit` 或 `Program::abort_pending` 消费整个 batch。Program 同时提交或回滚该 prefix
对应的 Main/backend KV、recurrent state、RNG 和 speculative state" (one commit or abort per
batch, committing KV, recurrent state, RNG and speculative state together). Each row's base is
revalidated before the fold and a mismatch throws rather than proceeding —
`program_impl.h:10040-10052`:

```cpp
        if (sequence.execution_frontier != pending.base_E ||
            sequence.ledger_frontier != pending.base_S || ... ) {
            throw std::logic_error("speculative pending row is not at its recorded base");
        }
```

The fold op additionally validates at construction that record planes are pairwise disjoint and
do not overlap state storage (`src/ops/linear_attention/gated_delta_net/replay.cpp:186, 255`:
`"gdn_replay_fold: record planes overlap"`, `"gdn_replay_fold: records overlap state storage"`)
and at execute time that active destinations are distinct and do not overwrite another row's
source (`replay.cpp:283`). vLLM's M3 was precisely an unvalidated overlapping source/destination
range; NInfer refuses to construct that plan. **This is a strong indicator, not a proof: I did
not trace the D2H synchronisation of `MtpDecodeEgress::accepted_drafts` back to the host read.**

### 3.6 Guards, and what the tests do and do not cover

**No guard exists refusing `--spec mtp` together with prefix reuse, and none is needed on this
reading.** The only speculative-backend exclusion in either binary is
`"--spec dflash cannot be combined with --vision"` (`apps/cli/options.cpp:219-220`,
`src/serve/serve_options.cpp:360-361`). MTP + prefix reuse is a first-class supported
combination, and `--no-prefix-reuse` exists as an operator switch
(`src/serve/serve_options.cpp:285-286`) rather than as a safety interlock. `docs/serving.md`
states the combination is handled deliberately:

> Speculative backends preserve protocol output shapes, stop behavior, and usage accounting. If
> a stop truncates a multi-token MTP or DFlash round, the Engine commits the exact accepted
> target prefix so a following compatible turn can reuse it.

and

> Reuse validation covers KV, recurrent state, hidden state, selected-backend state, and the
> exact prompt frontier.

**What the test suite does cover.** `tests/ops/test_gdn_replay_fold.cpp` drives the real fold op
across both registered geometries and asserts, per layer and per row:

- the folded recurrent state and conv history are **element-wise exactly equal**
  (`std::vector<float>` `!=`, no tolerance — lines 401-441) to a reference produced by running
  the sequential `ops::gated_delta_net` over the same records' first `commit` columns;
- `commit == 0` leaves the state byte-identical to its initial value (line 336-343);
- the fold does not modify its source slot, any inactive slot, the record storage, or the state
  outer guard bytes (lines 454, 472, 496, 506, 516, 526);
- plus a separate FP64 oracle check with a tolerance criterion (line 110-114).

`tests/targets/qwen3_6_27b/test_engine_prefix_real.cpp` is an end-to-end engine test that runs
**MTP with `draft_tokens = 3` and prefix reuse enabled together** across ~12 scenarios,
including `anthropic-prefix-regression` on **Qwen3.8-27B-NVFP4** — which is an A -> B -> A shape
(seed with tools {alpha,bravo}, intervening filler, re-send {alpha,bravo}, then branch to
{alpha,charlie}), structurally the same probe that reproduced the vLLM bug.

**What the tests do not cover, and this is the gap that matters.** The engine test asserts
*reuse accounting* — `prefix_reuse_path`, `reused_prompt_tokens`, and that computed prefill
equals `prompt_tokens - reused_prompt_tokens`. It does **not** assert that the cache-hit path
produces the same tokens as the cache-miss path. The only output-equivalence assertion I found
is one token deep (`exercise_zero_suffix_reuse`, line 390-392). So:

- fold-vs-sequential-recurrent state equality: **pinned bitwise** at the op level;
- fold-vs-*verify* state equality (the invariant `replayssm-gdn.md` §7.6 names as decisive):
  structural via shared `apply_gdn_transition`, **not pinned by a test that runs both ops**;
- hit-path output == miss-path output under MTP at scale: **not pinned by any test.**

That last one is exactly the property whose absence let vLLM ship four of these.

---

## 4. Is the *currently running* config exposed?

Running config: vLLM 0.28.0, Qwen3.8-27B-NVFP4, `enablePrefixCaching = true`,
`mamba_cache_mode align`, `kvCacheDtype fp8`, `maxNumSeqs 3`, **MTP off** (confirmed by
`vllm:spec_decode_*` absent from `/metrics`).

**No — not to this bug class.** Checked mechanism by mechanism:

- **M1** applied without MTP (smaller window), and is **fixed in 0.28.0** — verified in the
  v0.28.0 source at `scheduler.py:366-415`.
- **M2** is `drop_eagle_block = use_eagle and ...`. With MTP off, `use_eagle` is false and the
  branch never runs.
- **M3** is a speculative-decode conv-state shift copy. No speculation, no shift copy. (It is
  still worth taking, because it is the most likely blocker to re-enabling MTP — §1.5.)
- **M4** reads accepted-token counts. With MTP off there are none.

Independent corroboration that the no-MTP + prefix-caching path is clean, from three reporters
on three configurations: #47194's OP ("Hard-cache without MTP works correctly", 90-98% hit
rate, tool calling works, needle recall works); @johny-jose on #53912 ("0/288 with prefix
caching but no MTP"); @YashasRattehalli on #43559 ("removing the MTP speculative config while
keeping `--enable-prefix-caching` — zero crashes since").

**So the `models.nix` note that "prefix caching ... is the next thing off if corruption
outlives the MTP removal" is a reasonable operational stance but is not supported by any
upstream mechanism.** If corruption outlives #156, the evidence points at the tool parser
(§2.2) or at something not in this bug class, not at prefix caching.

---

## 5. Verdict

**Structurally immune.**

NInfer cannot produce the failure this study is about. The mechanism, in one paragraph: vLLM
writes recurrent state for every speculative verify position into a block-table slot and then
selects a committed slot by accepted count, and the corruption comes from that per-block state
being mislabelled on publication (#51113), left reachable when it should have been dropped
(#43650/#48375), copied with overlapping source and destination (#50729), or selected with
another request's accepted count (#51571). NInfer's verify pass — `gated_delta_net_replay_record`,
contract: "*without modifying any state*" — writes no state at all; it emits raw transition
records, and on commit folds exactly the accepted prefix forward from the unchanged checkpoint
using the same `apply_gdn_transition` device function the verify pass ran, with rejection being
`commit_columns = 0`, a "strict no-op for the row: no record or state is read." There is nothing
poisoned to publish. Independently, NInfer has no per-block state hash to mislabel: a reusable
prefix is one immutable whole StateImage bound to one exact token frontier, and "只有 token
match、KV bytes 或 page match 时，缺少的是完整 continuation，不是一次部分 cache hit" — a partial
match is a miss, not a partial hit, and digests are explicitly a shortlist that "不证明命中"
(does not prove a hit).

The immunity is to the *design-level* hazard. It is not a claim that NInfer is free of
corruption bugs. Nothing here was built or run; the fourth upstream mechanism is an
implementation race whose NInfer analogue I did not trace to completion; and no test in the
repository asserts that the cache-hit path produces the same output as the cache-miss path.

---

## 6. What would settle the remaining uncertainty

Ordered by cost. The first item is the one that most changes the decision, and it is about
vLLM, not NInfer.

1. **Bump the vLLM image to `v0.28.1` (or `v0.28.1rc0`) and re-enable MTP for a soak.** ~1 hour
   plus soak time. #50729 is merged, is confirmed by a reporter to fix this symptom, and is
   verifiably absent from the running 0.28.0. If MTP is safe on 0.28.1, the entire migration
   premise ("NInfer buys back the speed MTP removal cost") evaporates and this study's answer
   becomes "don't migrate, upgrade." **Run this before anything else.**
2. **Disambiguate the parser confound (§2.2).** Re-enable MTP on the *current* 0.28.0 image with
   `toolCallParser = qwen3_xml` retained. If clean, the 2026-09-02 incidents were the parser and
   MTP never needed removing. Half a day, no new artifacts.
3. **For NInfer, the one test that would close the gap in §3.6:** a determinism harness that
   sends prompt A, then a divergent prompt B, then prompt A again, at temperature 0 with
   `--spec mtp --draft-tokens 3`, and asserts the third response is token-identical to the
   first — then repeats with `--no-prefix-reuse` and asserts both arms agree. This is
   @raoulprevost's v3 probe shape, which is what actually caught the vLLM bug when unit tests
   did not. NInfer's `anthropic-prefix-regression` scenario already builds this traffic shape;
   it just checks accounting instead of output. Requires a build.
4. **The bitwise fold-vs-verify pin.** Run `gated_delta_net_replay_record` and
   `gdn_replay_fold` against each other on the same records and assert element-wise FP32
   equality of the resulting state at `m = 0, 1, T` and intermediate `m` — the exact checklist
   `replayssm-gdn.md` §4.5 sets out and that its own test suite does not execute. Cheap once
   the project builds; the shared `apply_gdn_transition` makes it very likely to pass, and the
   value is in catching a future refactor that splits the two paths.
5. **Trace the accepted-count synchronisation.** Follow `MtpDecodeEgress::accepted_drafts` /
   `licensed_counts` from the device egress buffer to the host `accepted_tokens` span consumed
   at `program_impl.h:10054`, and confirm the copy is awaited before any host-side reordering.
   This is the only path on which NInfer could reproduce vLLM's M4. Desk-readable; I ran out of
   budget before reaching it.
