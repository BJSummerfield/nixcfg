# 05 — Does the `drop_eagle_block` patch actually fix it?

Agent R5. Written 2026-09-04. Sources: vLLM upstream issues/PRs read via `gh api` on 2026-09-04;
vLLM source read at `main` HEAD `a69e75b9b6d6a26d90b6790e2eb75b3419a47c16` (2026-09-04T13:32Z) and
at tags `v0.25.1`, `v0.26.0`, `v0.27.1`, `v0.28.0`, `v0.28.1rc0`, plus PR #43650's base commit
`e6adbd783422135db8c144d909f04fe483f3c013`; Docker Hub tag listing for `vllm/vllm-openai`.

Builds on `03-mtp-prefix-cache-correctness.md` (agent R2). M1/M2/M3/M4 labels are R2's.

Every claim is **quoted** (link given), **measured** (command given), or **inferred** (labelled).

---

## 0. Verdict

**Unproven — and for the specific patch this stack intends to bind-mount (#43650), actively
questionable.**

Broken out, because the answer differs by variant and by symptom class:

| Variant | Fixes the corruption? | Confidence |
|---|---|---|
| **#43650** (6 lines, `max_num_blocks -= 1`) | **Unproven on any build newer than 2026-07-12.** Three first-hand "it fixed it" reports exist, all from 2026-06-07…09. All three predate #46384 (merged 2026-07-12), which changed the surrounding coordinator so that *the same 6 lines are no longer the same change* (§4.1). Nobody has reported a before/after corruption measurement with #43650 on v0.26.0 or later. | Low |
| **#48375** (180 lines, same read-path idea) | **Unproven.** One soft first-hand confirmation on ROCm/RDNA4 (`jack10768`, "clean so far", no denominator). The PR author states he **could not reproduce the output corruption at all** on CUDA and that his e2e test asserts `num_cached_tokens`, not output. One 58-request soak on RTX 5090 + Qwen3.8-27B NVFP4 with zero correctness failures — but no A/B arm. Merge-conflicted since 2026-08-28. | Low |
| **#50729** (M3, conv-state copy race) | **Yes, as far as one-reporter evidence goes** — and it is *already merged*, absent from v0.28.0, present in `v0.28.1rc0` and all nightlies. Two independent 0.27.1→nightly measurements (§2, rows E1/E2). | Moderate |
| **#53919** (M4, async accepted-count race) | **Yes**, with the strongest statistics in the whole cluster (29/1248 → 0/1248, Fisher p=1.6e-9) — but gated on async scheduling. **Note: async scheduling defaults ON when MTP is enabled** (§4.4), so it is *not* automatically out of scope for this stack. Still open. | Moderate-high, but scoped |
| #48815, #53479, #53945, #54713, #53802, #54163, #54165, #51351 | **Not corruption fixes at all** (§4.3). Six of these are *hit-rate recovery* PRs that push in the **opposite direction** from #43650; #54163/#54165 are DFlash/DSpark-scoped and explicitly no-op for MTP; #51351 is a control-plane refactor with no runtime evidence. | — |

**The decision-relevant conclusion.** If the goal is to re-enable MTP + prefix caching + batching
without corruption, the evidence supports *upgrading the image* (to a nightly, which carries #50729)
far better than it supports *patching a file*. Two independent reporters measured
0.27.1 → post-0.28.0-nightly going 12/5000 → 0/5000 and "solves the issue" on this exact
symptom class. Nobody has produced a comparable measurement for #43650 on a current build.

**Two things that would be false confirmations if taken at face value**, both on the record:

1. `puririshi98` (#43559, GB200, Nemotron-3-Super-120B) found that #47861/#46281/the #45477+#47861
   combination "stop the corruption **only because hybrid prefix-cache hits drop to exactly 0**
   across >150k queries — caching effectively disabled for the pattern, **not cured**." #43650 is in
   the same mechanism family (shrink the hit until the poisoned block is unreachable), so "clean
   after patching" must be read together with a hit-rate counter or it means nothing.
2. `ionut-anghelina`'s #43650-on-0.28.0 run — the only report of #43650 on a modern build — is
   **0 malformed in 100 requests** against a baseline rate of 4/495 (0.81%). Expected count at that
   rate is ~0.8. That result is statistically indistinguishable from no effect.

---

## 1. Symptom classes — they are not the same bug and may not have the same fix

The thread cluster conflates two failure shapes. Keeping them apart changes which reports count.

- **Class A — degradation.** Accuracy drop on a benchmark; a tool call omitted; a needle not
  recalled; "the model got dumber". Output is well-formed. Examples: #43559's ~94% → ~75%
  classification, `zack041`'s gsm8k 0.876–0.894 vs 0.914, `timothysu`'s tool-eval-bench ~90% → ~50%,
  `raoulprevost`/`amittell`'s deterministic "12/20 tools, missing positions 9–16".
- **Class B — corruption.** Mojibake / CJK runs / `!!!!` / `ARGARG` / broken braces; `<tool_call>` XML
  leaking as plain text; malformed tool JSON; empty content with `finish_reason: stop`; degenerate
  loops. Examples: #53912's `!` runs, `rdlh`'s CJK/`ARGARG` samples, `karls0r`'s hour-long CJK
  window, `alexbi29`'s `content: null / completion_tokens: 1`, this stack's 2026-09-02 incidents.

**#43650's own evidence base is almost entirely Class A.** Its author's test plan is gsm8k accuracy.
The two maintainer comments on it are about accuracy and perf, not corruption. Exactly **one**
first-hand Class-B confirmation of #43650 exists (`alexbi29`, empty-content EOS), and it is
unreplicated on any build after June 2026.

Conversely the two merged/mergeable *races* (#50729 M3, #53919 M4) are confirmed against Class B
specifically — mojibake, `!!!!` runs, digit-splicing. **Inference, labelled:** the split suggests
M2 (`drop_eagle_block`) is predominantly a Class-A mechanism and the races are the Class-B
mechanisms. This stack's incidents were Class B.

---

## 2. Evidence table — every report of someone actually running a patch

First-hand = the reporter ran it. Restated = quoting someone else. AI-disclosure noted where the
reporter disclosed it.

| # | Reporter / link | Variant run | Hardware | Model / quant / KV | Flags | Before | After | Symptom class | Notes |
|---|---|---|---|---|---|---|---|---|---|
| P1 | [`alexbi29`, #43650, 2026-06-07](https://github.com/vllm-project/vllm/pull/43650#issuecomment-4641688875) | **#43650** | TP=2 (GPU unstated) | Qwen3.6-27B GDN/Mamba hybrid | MTP k=3, APC on | "about 1 in 8 decode runs returns `content: null`, `finish_reason: stop`, `completion_tokens: 1`" | "This fix **resolves it completely**." | **B** (empty-content EOS) | First-hand. No denominator, no post-fix count. Base was upstream `main` around `efc347f1b`→`9c7f7741d`, i.e. **pre-#46384**. |
| P2 | [`andysalerno`, #43650, 2026-06-07](https://github.com/vllm-project/vllm/pull/43650#issuecomment-4644145506) | **#43650** | 2× AMD (ROCM_AITER_UNIFIED_ATTN), TP=2 | Qwen3.6-27B-FP8, `--kv-cache-dtype fp8` | MTP k=3, APC, `--max-num-seqs 4`, `--tool-call-parser qwen3_coder` | "my benchmark passes **18/39**. Without mtp, it passes 39/39." | "I applied the patch in this PR and it passed **39/39** again, even with mtp 3." | A (task pass/fail) | First-hand, largest single effect in the cluster. Private benchmark, contents unknown. Date ⇒ pre-#46384. |
| P3 | [`timothysu`, #43650, 2026-06-09](https://github.com/vllm-project/vllm/pull/43650#issuecomment-4655150710) / [#43559](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4655086131) | **#43650** | unstated | Qwen3.6-27B and 3.6-35B-A3B; **bf16 KV** | MTP k=3, APC, tool-eval-bench | "~90% using either spec dec OR prefix caching to **~50%** when using both" | "I can confirm this fixes the issues when using **bf16** kv-cache" | A (tool-call accuracy) | First-hand. **Also the key negative — see N1.** Pre-#46384. |
| P4 | [`ionut-anghelina`, #53912 body, 2026-08-26](https://github.com/vllm-project/vllm/issues/53912) | **#43650 on v0.28.0** | 1× H100 80GB, TP=1 | Qwen3.5-arch 27B VLM FP8 dynamic, MTP head in ckpt | MTP k=2, APC, `--mamba-cache-mode align`, `--max-num-seqs 32`, async sched default | baseline 4/495 malformed (0.81%) | "starts cleanly and shows no regression on an unrelated accuracy check (100 grounding requests at concurrency 32: **76% vs 75%** unpatched, identical coordinate error, **0 malformed**)" | B (baseline), but the check is A | **The only #43650 run on a modern build.** Under-powered: 100 requests at 0.81% ⇒ expected ~0.8 malformed. Not evidence of efficacy; the author does not claim it is. |
| P5 | [`jack10768`, #48375, 2026-07-23](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5052878707) | **#48375** | 4× AMD R9700 (RDNA4, gfx1201) | Qwen3.6-27B BF16 | MTP n=3, APC align, v0.23-based build | "tool calls are emitted wrongly — emerging as plain text blocks or malformed json"; toggled reliably with `cache_salt` | "With the patch applied it's been **clean so far**; running heavier tool use over the next few days to confirm." | **B** (leaked/malformed tool calls) | First-hand, but soft and open-ended. No follow-up posted. He also says "I am super concerned that the initial symptom only became evident after **10 days** of use" — i.e. his own detection latency exceeds his confirmation window. |
| P6 | [`yychyo`, #48375, 2026-07-23](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5058016206) | **#48375** | 2× 3090 + RTX 6000 Blackwell | Qwen3.6-27B | (compose from a Reddit comment) | — | "model started to behave better … **as this is a non-deterministic issue, I can't really test it properly** … no issues with large agentic sessions (up to 256k), and overall models feels more stable" | vibes | Explicitly non-quantitative by the reporter's own admission. |
| P7 | [`noonghunna`, #43559, 2026-07-17](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5005615476) | **#48375** vendored onto v0.25.1 | 2× RTX 3090 | Qwen3-Next hybrid: dense 27B + 35B-A3B MoE | MTP n=3, APC | — | "boots clean, MTP acceptance intact (accept-len 3.2–3.9), **tool-call probes clean post-agent-workload with `prefix_cache_hits_total` asserted**. +1 for landing #48375" | B (tool-call probes) | First-hand, and the **only** report that asserts cache hits were live while clean — the control `puririshi98` says everyone else is missing. Still no before-arm. |
| P8 | [`seanyourhighness`, #48375, 2026-08-20](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5358310314) | **#48375** | **RTX 5090** | **Qwen3.8-27B NVFP4, NVFP4 KV** | MTP-3, async scheduling, APC + chunked prefill | — (no before arm) | 58 requests / 1,461,705 prompt tok / 33,230 gen tok; max 7 concurrent streams; acceptance 71.1%; peak KV 81%; **"Zero HTTP 500, FSM, grammar, OOM, preemption, or output-correctness failures"**; mean TTFT 2.8 s | B (absence of) | **Closest hardware+model match to this stack.** But: combined-stack soak, not an isolated PR-head comparison (his words); 58 requests; hit rate only ~55%; **AI-assisted analysis disclosed**; no wall-clock, so no tok/s (§6). |
| P9 | [`jogoossens`, #48375, 2026-08-31](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5476046737) | #48375 | — | — | — | — | "We use this patch too now" | — | Adoption, not evidence. |
| P10 | [`estrella159`, #43559, 2026-07-07 / 07-08 / 07-09](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4907455987) | **#47861** (the M2 sibling that died on conflicts) on v0.24.0 | RTX PRO 6000 Blackwell, TP=1 | Qwen3.6-27B-FP8 and 3.6-35B-A3B-FP8; fp8 **and** bf16 KV | MTP n=2, APC, chunked prefill, align | could not reproduce the bug at all | "the patch applies cleanly and is **harmless + directionally correct**, but I **could not reproduce #43559** on either base checkpoint, so I can't confirm it *fixes* the bug — only that it doesn't break anything." | A | First-hand, negative-control quality. Also ran the patched build on real production traffic ~8h: "No #43559-style regression … but I could not force the original regression to appear to prove the patch fixes it." |
| P11 | [`leopck`, #43559, 2026-07-08](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4918842036) | #47861 | — | — | — | — | "I tried that patch there were a **marginal improvement** but still it **does not fix everything** properly for me." | B (#47087/#47194 shapes) | See N3. |
| P12 | [`puririshi98` (NVIDIA), #43559, 2026-07-11](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4948150114) | #47861, #45614, #46281, #45477 — all five open fixes | GB200, TP=4 | Nemotron-3-Super-120B-A12B-BF16 | MTP + APC, deterministic e2e corruption tests | both mechanisms reproduce on `main` | "#47861, #45614, #46281 each **cure the multi-turn lane** … **None fixes the cold-race lane**; #47861/#46281/the #45477+#47861 combination stop the corruption **only because hybrid prefix-cache hits drop to exactly 0** across >150k queries — caching effectively disabled for the pattern, **not cured**." | A+B | **The single most important methodological result in the cluster.** See N2. |
| E1 | [`ionut-anghelina`, #53912, 2026-08-28](https://github.com/vllm-project/vllm/issues/53912#issuecomment-5456306856) | **#50729** (merged; M3) | 1× H100 | Qwen3.5-arch 27B FP8 | MTP k=2, APC, align | 4/495 malformed on v0.28.0 | "I managed to check fix #50729 and **it solves the issue**." | **B** | First-hand. No post-fix count given. |
| E2 | [`rdlh`, #53912, 2026-09-02](https://github.com/vllm-project/vllm/issues/53912#issuecomment-5510771012) | nightly `0.28.1rc1.dev284+gc00091e02` (contains #50729) | unstated | Qwen3.6-35B-A3B-FP8 | MTP k=1, APC, temp 0.7, concurrent load | **12 / 5000 corrupted** on 0.27.1 (CJK, `ARGARG`, broken braces) | **0 / 5000** on nightly, "same flags, same prompts, same concurrency" | **B** | First-hand, best-powered Class-B before/after in the cluster. Independent of #43650 entirely. |
| E3 | [`johny-jose`, #53919, 2026-08-26](https://github.com/vllm-project/vllm/pull/53919) | **#53919** (M4) | 1× H200, `--cpus=4` | **Qwen3.8-27B-FP8** | MTP k=3, APC, async sched, `--max-num-seqs 64`, conc 24 | main: **29/1248 (2.32%)** wrong; v0.27.1: 16/288 (5.56%) | **0/1248** and **0/288**; Fisher exact **p = 1.6e-9**; also 186/5400 → 0/5400 at conc 100 on v0.26.0 | **B** (digit splicing, then `'**\n</think>!!!!!!!!'`) | First-hand, only statistically-tested result in the cluster. Requires async scheduling (§4.4). |
| E4 | [`uraniumchonk`, #53505, 2026-08-30](https://github.com/vllm-project/vllm/issues/53505#issuecomment-5468330361) | **#54165** on v0.28.0 | 2× RTX 3090, TP=2 | Qwen3.8-27B AWQ-INT4 | **DFlash2 n=7** (not MTP), APC, align, `--block-size 1600`, LMCache connector, 8 parallel convs | "Before #54165 this exact traffic was **100% reproducible**" (U+FFFD salad, runaway, empty) | 24 h / ~500 req / 40M prompt tokens: 0 U+FFFD, 0 runaway, 0 empty; connector hit rate 96.4%; spec acceptance 36.2% | **B** | First-hand, 24 h, cache proven live. **But the drafter is DFlash2, not MTP** — #54163/#54165's mechanism is that DFlash is *misclassified* as eagle-family; MTP is unaffected by that fix (§4.3). |
| E5 | [`jschmied`, #53670, 2026-09-04](https://github.com/vllm-project/vllm/issues/53670#issuecomment-5539850703) | **#53388** `disable_eagle_block_drop: true` (merged 2026-09-01) — i.e. the **opposite** of #43650 | 1× GB10 (sm_121) | Qwen3.8-Flash-Next | MTP n=3, APC, batch 4096, 8-turn agent loop, 3 interleaved server starts per arm | drop on: warm turn 2.05 s, 4,800 hit tok, acceptance 56.1/53.3/53.8% | drop off: **1.52 s (−26%)**, **6,400 hit tok**, acceptance 59.5/57.5/60.0%; **no corruption reported in either arm** | (none observed) | Posted today. First-hand, AI-disclosed. Directly contradicts the premise that the drop is load-bearing for output correctness on this model class (§4.2). |

---

## 3. Negative and contradictory evidence

This section is deliberately longer than §2.

**N1 — `timothysu`: the patch's own confirmer reports not experiencing the bug on this stack's KV
dtype.** [#43650, 2026-06-09](https://github.com/vllm-project/vllm/pull/43650#issuecomment-4655150710):

> I can confirm this fixes the issues when using **bf16** kv-cache in the way described. **I did not
> experience any accuracy issues** using `--speculative-config '{"method": "mtp",
> "num_speculative_tokens": 3}'` with `--enable-prefix-caching` and `--kv-cache-dtype fp8`, unlike
> the comment above.

This stack runs `kvCacheDtype = "fp8"`. Corroborated by `eblanshey` ([#43559,
2026-07-08](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4919373119)): "After
reading @estrella159's comments, I switched to fp8 kv cache, and so far I haven't encountered the
issue." **Contradicted** by `dmih` on the same day: "fp8 is not the solution: it just shifts this
random damage to some other area which is less obvious … In my case, all cache types display this
behaviour." And by #53912's OP, who shows fp8 KV appearing to fix it *only because* it raises the
attention block 800 → 1600 and collapses hit rate 31.7% → ~10%. So fp8 KV is at best exposure
reduction, and it is one more reason a "clean after patching" result on fp8 KV is weak.

**N2 — the fix-by-cache-disablement false positive, measured.** `puririshi98` (NVIDIA), [#43559,
2026-07-11](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4948150114), on GB200 with
deterministic e2e corruption tests that fail on `main`:

> #47861 / #46281 / the #45477+#47861 combination stop the corruption **only because hybrid
> prefix-cache hits drop to exactly 0 across >150k queries — caching effectively disabled for the
> pattern, not cured.**

He also found "**None** fixes the cold-race lane". #43650 is the most aggressive member of this
family (it shrinks the hit unconditionally, and on current main by a full mamba block more than the
others intended — §4.1). Any #43650 soak that does not report `vllm:prefix_cache_hits_total` is
uninterpretable. Of the reports in §2, only P7 (`noonghunna`) and E4 assert cache liveness.

**N3 — "marginal improvement, does not fix everything."** `leopck`, [#43559,
2026-07-08](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4918842036), on the M2
sibling #47861. `estrella159` reads it the same way: "your 'marginal improvement, does not fix
everything' reads consistent with the patch closing one path while #47087 and #47194 cover others."

**N4 — the #48375 author cannot reproduce the output corruption.** `potto007`, [#48375,
2026-07-23](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5054159795):

> Caveat: in our natural-load e2e runs the retained snapshots happened to be **numerically clean**,
> so **the output corruption itself did not reproduce on CUDA** under greedy serial load.

His canonical test therefore asserts `num_cached_tokens` (2800 → 2240), i.e. *that the block was
dropped* — not that output improved. The same comment discloses a **cache-hit-rate regression**:

> when only the final boundary block has cached mamba state, the fixed code's hit **collapses to
> zero**, because mamba cannot resume without an earlier state block. Safe, just less cache benefit
> in that corner.

**N5 — the drop can cost the *entire* hit, pinned as an executable test.** `akshaver`'s test PR
[#52371](https://github.com/vllm-project/vllm/pull/52371) §3 covers the served-system-prompt shape
(shared preamble, per-request suffix — this stack's shape):

> the joint hit today is `0` — the consumer recomputes the entire shared prefix. … Here the drop
> does not cost a block — it costs the **entire** hit, while both groups independently reach at
> least 12.

**N6 — measured in production: prefix caching hits *nothing* under MTP on some hybrids.**
`tobymao`, [#54713, 2026-09-01](https://github.com/vllm-project/vllm/pull/54713): "Prefix caching
never hits on hybrid models running MTP/EAGLE spec decode. Measured on GLM-5.3-Flash in production:
**0 hit tokens against 16,897 queried**, silently." `Suppressor72`, [#53504](https://github.com/vllm-project/vllm/issues/53504),
on **Qwen3.8-27B-FP8, dual RTX 5090, TP=2, MTP k=2**: "request 2 `prefix_cache_queries_total` +11,910
with **0** hit tokens". This is on *unpatched* builds; #43650 pushes the reachable boundary a further
block down.

**N7 — four independent non-reproductions of the underlying bug.**
- `estrella159` (P10): could not reproduce across {fp8, bf16} KV × {none, align} × {27B, 35B-A3B} ×
  {stock, #47861} on base checkpoints.
- `amittell`, [#43559, 2026-07-20](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5017979244):
  RTX PRO 6000, Qwen3.6-27B NVFP4, 0.24.0 — "APC off scored 0.95, APC on (cache hitting) scored 0.95
  … the cache-hit output was **byte-identical** to the cache-miss output on all 12." **Then corrected
  himself** ([2026-07-25](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5081036325)):
  "I now believe that result is correct but answers the wrong question. The corruption needs an
  **intervening request with a different prefix** between two identical requests. Stable-cache hit vs
  miss stays clean; the A → B → A eviction/perturbation pattern is what breaks."
- `cduk`, 0.19.1 / Qwen3.5-9B: `RESULT: NOT_REPRODUCED` on `raoulprevost`'s probe.
- **`gjc1202`**, [#47194, 2026-08-26](https://github.com/vllm-project/vllm/issues/47194#issuecomment-5428414951)
  — the most directly relevant: **dual RTX 3090, Qwen3.8-27B W8A16 hybrid GDN/Mamba, TP=2,
  vLLM 0.28.0 unpatched, MTP k=3 + APC + fp8_e4m3 KV + `mamba-cache-mode align` +
  `--prefix-match-unit 16`**, greedy three-arm A/B/C: needle recall 100/100/100%, 200 tool calls with
  0 violations, 0 cross-turn leaks, no drift. "**MTP + prefix cache co-enabled shows no silent quality
  degradation.**" If the base is already clean on our model class, a patch cannot improve it — and
  can only cost hit rate.

**N8 — corruption survives on builds where M2 is unchanged, in a way M2 does not explain.**
`karls0r`, [#53912, 2026-08-31](https://github.com/vllm-project/vllm/issues/53912#issuecomment-5485744380):
2× RTX 3090 TP=2, Qwen3.8-27B INT8, fp8_e4m3 KV, `--max-num-seqs 4`, MTP k=2 — an hour-long window
where *every* cache-hit request returned endless CJK or empty, "**including a trivially short 'reply
with just OK'**". A one-turn "reply with just OK" cannot be explained by a stale mamba block retained
from a prior request's rejected drafts unless that block came from *another* request — which points
at M3/M4, not M2. (AI-assisted, disclosed: "researched and written by Ren, an AI agent operated by
karls0r, with his review.")

**N9 — the drop is upstream-understood as an *acceptance-rate* protection, not a correctness one.**
`Suppressor72`, [#53670](https://github.com/vllm-project/vllm/issues/53670): "Speculative decoding
stays lossless (the target verifies every token), so the damage is **acceptance degradation rather
than wrong outputs**." That framing is about draft-layer KV; it is **not** obviously true of mamba
recurrent state, which is the target model's own state. But it is the framing upstream acted on: on
2026-09-01 they **merged an option to turn the drop off** (#53388), and the first field measurement
of that option (E5, today) reports better throughput, better acceptance, and no corruption.

**N10 — one report of a possible regression direction.** `zack041`'s own numbers show the patched
arm *slower* than unpatched (2493.9 → 1982.5 output tok/s on gsm8k, −20.5%), which he attributes to
the extra recompute. He also logged `Invalid responses: 0.002` on the patched arm vs `0.000` on the
other two — a single anomalous cell he does not comment on. Weak, noted for completeness.

---

## 4. Variant-conflict analysis — is #43650 alone coherent on current nightly?

### 4.1 No. The 6 lines are a different change than they were when they were validated.

**#43650's diff** (`gh api repos/vllm-project/vllm/pulls/43650 -H "Accept: …v3.diff"`), one hunk,
`vllm/v1/core/single_type_kv_cache_manager.py` at line 878, against base
`e6adbd783422135db8c144d909f04fe483f3c013`:

```python
         block_size = kv_cache_spec.block_size
         max_num_blocks = max_length // block_size
+        if use_eagle and max_num_blocks > 0:
+            # ... Instead, we can only search up to the boundary (not include final)
+            max_num_blocks -= 1
         # Search from right to left and early stop when a match is found.
```

**The coordinator at that base commit** (`kv_cache_coordinator.py:561-572`, fetched at
`e6adbd78…`) gave the margin to **every** group, mamba included:

```python
                use_eagle = (
                    idx in self.eagle_attn_group_indices and idx not in eagle_verified
                )
                _max_length = curr_hit_length
                if use_eagle:
                    # Eagle needs to match one more block and then pop the last.
                    _max_length = min(
                        curr_hit_length + spec.block_size, max_cache_hit_length
                    )
```

So on that base: **+1 block margin, then #43650's −1 block = net zero.** The mamba hit lands *at* the
candidate, matching full attention. That is the change P1/P2/P3 validated.

**#46384** ("[2/N][Core] support partial prefix cache hit for hybrid model", author **ZJY0516**,
merged **2026-07-12**) removed the margin for mamba. Verified from its diff:

```diff
-                    # Eagle needs to match one more block and then pop the last.
+                # Eagle matches one extra drop unit (one hash unit for
+                # fine-grained managers, else one cache block) and then drops
+                # it, landing back at the candidate length. No margin for
+                # mamba: its finder never drops (draft models have no mamba
+                # layers), so the hit would grow past the candidate.
+                if drop_eagle_block and not isinstance(spec, MambaSpec):
```

Verified present at `v0.26.0`, `v0.27.1`, `v0.28.0`, `v0.28.1rc0`, and `main` HEAD `a69e75b9`
(`kv_cache_coordinator.py:848`). Absent at `v0.25.1`. Release dates: v0.25.1 = 2026-07-14,
v0.26.0 = 2026-07-27.

**Consequence.** On current main/nightly, applying #43650 gives **no margin, then −1 block = net −1
mamba block below the candidate**, on every EAGLE cache hit, on top of the full-attention group's own
drop. That is *not* the behaviour any of P1/P2/P3 measured. It is strictly more conservative
(therefore not a correctness hazard), but it is a hit-rate change of one **mamba** block — 1,600–2,128
tokens on this model class, per hit — and per N5/N6 it can take the joint hit to **zero**.

Two secondary mechanical problems with applying it verbatim:

1. **It does not apply cleanly.** The parameter was renamed `use_eagle` → `drop_eagle_block` (main
   HEAD `single_type_kv_cache_manager.py:1426`) and the hunk moved from line 878 to ~1471. A
   hand-port is required; that is a small but real risk on a bind-mounted file with no CI.
2. **On main there is a new early-return above the patch site.** `MambaManager.find_longest_cache_hit`
   now has a fine-grained branch (`if alignment_tokens < block_size and block_size % alignment_tokens
   == 0: … return computed_blocks, hit_length`) that returns *before* `max_num_blocks` is ever
   computed. So if this stack ever sets `--prefix-match-unit` finer than the block size, **#43650
   becomes a silent no-op**. (This stack currently sets no `prefix_match_unit` — checked
   `modules/local-llm/models.nix`; the branch is inert today. Recording it because several upstream
   reporters on this exact model do set `--prefix-match-unit 16`.)

**The hole itself is still open on main.** Verified 2026-09-04 at HEAD `a69e75b9`: the signature
takes `drop_eagle_block` (line 1426) and the body never references it again; the coordinator still
skips the margin for `MambaSpec` (line 848). R2's M2 diagnosis stands unchanged.

### 4.2 Upstream has moved in the opposite direction, and it merged

**#53388** ("[Feature][Spec] Support disabling trailing prefix-cache block dropping", author
ZeldaHuang) **merged 2026-09-01** (`481839ad9e5eb`, +112/−21, 13 files). It adds
`disable_eagle_block_drop` to `--speculative-config` for EAGLE-family methods, "keeps the trailing
prefix-cache block instead of conservatively dropping it", and states the trade explicitly:

> This does not bypass target-model verification. The option can change which draft tokens are
> proposed and therefore may affect speculative-token acceptance rates, but **accepted output tokens
> are still verified by the target model.**

The *only* field measurement of it, E5 (`jschmied`, today), found acceptance **improved** and warm
turns 26% faster with the drop off.

So: #43650 says "mamba must also drop the block, for correctness." Merged #53388 says "you may turn
the drop off for everyone, it costs acceptance at worst." These cannot both be right about the same
risk. Nobody upstream has reconciled them.

### 4.3 The other seven "M2 variants" are not corruption fixes

Read against the question "does it stop the mojibake":

| PR | State (2026-09-04) | What it actually does | Direction vs #43650 |
|---|---|---|---|
| #48375 | open, **`dirty`** (conflicts since 2026-08-28) | Same read-path idea, 180 lines, with tests. Author-declared "minimal correctness fix"; author could not reproduce output corruption (N4). | Same |
| #48815 | open, **`dirty`** | Opt-in env flag `VLLM_MAMBA_ALIGN_RETAIN_MTP_CACHE_BLOCK=1` to **retain** the block. Pure hit-rate. | **Opposite** |
| #53479 | **draft**, `dirty`, self-superseded 2026-09-03 | "materialize a state at every boundary and **drop the speculative one-block back-off**". Pure hit-rate. Author has moved it behind #54076/#54713. | **Opposite** |
| #53945 | open, `blocked`, `ready` label, under active review | "Cache the Mamba state at the block-grid position of EAGLE resume". Opt-in flag, default off. Body: "The quantity this change moves is prefix-cache **hit length**". | **Opposite** |
| #54713 | open, `blocked`, **DCO `action_required`, no `Signed-off-by`** | Retain a state one block below each boundary so the post-drop lookup can find it. Pure hit-rate (0 → 4,608 hit tokens). | **Opposite** |
| #53802 | open, `blocked`, `verified` label | Boundary arithmetic: floor registration from `n−1` and apply the eagle shift. Pure hit-rate (0% → 98% hits on a 132k doc). | **Opposite** |
| #54163 / #54165 | open, `blocked` / `dirty` | Scope the drop to `eagle/eagle3/mtp` only, so **DFlash/DSpark stop dropping**. #54163: "**No behavioral change for** `eagle`/`eagle3`/**`mtp`**". | N/A for MTP |
| #51351 | open, **`dirty`**, no runtime evidence | Declare `supports_eagle_cache_peek` as a manager capability, default unsupported. Control-plane refactor; author states "**No model evaluation or GPU benchmark was run**". AI assistance disclosed. | Architectural |

So of the nine PRs named in the brief, **exactly two (#43650, #48375) attempt to fix M2 in the
correctness direction, and five actively try to undo the cost that direction imposes.** Applying
#43650 puts this stack on the losing side of a five-to-two upstream consensus about which way this
code should move.

**Composition with what is already in a nightly.** #43650 touches one function in
`single_type_kv_cache_manager.py`. #51113 (M1, in v0.28.0) touches `sched/scheduler.py`. #50729 (M3,
in nightlies) touches `worker/mamba_utils.py`. **No textual conflict.** But #46384 — the semantic
conflict of §4.1 — is in the same function's *caller*, and it is already merged everywhere.

### 4.4 A trap this stack would walk into: async scheduling defaults ON with MTP

Verified in `vllm/config/vllm.py` at `v0.28.0` (lines 1185-1207): when `async_scheduling is None`,
the disable branch requires `speculative_config.method not in get_args(EagleModelTypes)`. `mtp` **is**
in `EagleModelTypes`, so it does not hit the disable branch — async scheduling stays on. Corroborated
by `erdholion` ([#53912, 2026-09-02](https://github.com/vllm-project/vllm/issues/53912#issuecomment-5516040496)):

> On 0.27.1 with `"method": "mtp"`, async scheduling defaults to **on** unless you passed
> `--no-async-scheduling` … MTP is in `EagleModelTypes`, so it doesn't hit the disable branch.

`modules/local-llm/` sets no async-scheduling flag (grep: no matches for `async`). **So re-enabling
MTP on this stack silently enables M4 exposure** — the mechanism with the best-evidenced fix
(#53919, E3, p=1.6e-9) and that fix is still unmerged. `--no-async-scheduling` is a one-flag
mitigation that #53919's own data shows costs 4.4% at the throughput knee (§6, row T9).

---

## 5. Maintainer signal

**There is essentially none since May 2026, and what exists is negative.**

Every PR in the cluster has the same auto-assigned CODEOWNERS reviewer list (`njhill`, `orozery`,
`ApostaC`, `WoosukKwon`, `alexm-redhat`, `robertgshaw2-redhat`, `ywang96`, `heheda12345`, …) and no
human review from any of them. The complete set of maintainer utterances on M2:

**On #43650 — the only two, both 2026-05:**

- **`ZJY0516` (MEMBER), 2026-05-27**, review, verbatim and in full: *"The perf drop seems
  unacceptable"*.
- **`heheda12345` (COLLABORATOR), 2026-05-28**, review, in full:

  > I'm not sure whether this is a bug. My current understanding is, we only need to drop last block
  > **when this group contains eagle layer**. and even if it is a bug, as qwen 3.5 block size is
  > >1k, accuracy drop due to incomplete block should be **less than 0.1%**. the 1% accuracy drop
  > should have **other reasons**.
  >
  > A stronger test can be, for linear attention, add another linear attention state f(0)=0,
  > f(i)=f(i-1)+1, and check whether the hit f(i) == i.
  >
  > CC @benchislett

  This is a maintainer stating (a) he is not convinced there is a bug, (b) the magnitude does not add
  up, and (c) a discriminating test that, as far as I can find, **nobody in the cluster ever ran**.
  `zack041` replied conceding "simply dropping last block can be too blunt" and proposing the
  alternative "**not annotate eagle for mamba**" — which is, in effect, what `ZJY0516` then
  implemented six weeks later in #46384 (§4.1). **Inference, labelled:** #46384's mamba exclusion
  looks like the maintainers' chosen resolution of #43650, i.e. they resolved it the *other* way.
  That would explain why #43650 has sat at `mergeable_state: blocked` with no review for 100 days.

**Everywhere else:**
- #48375, #48815, #51351, #52371, #53479, #53802, #54713: **zero** human reviews (only bots and
  `mergify`). #48375 and #51351 carry `needs-rebase`.
- #53945: `benchislett` (MEMBER), 2026-08-31, the only recent maintainer comment in the cluster, and
  it is about test bloat: *"Over 1000 lines of tests for 200 lines of code is far too much."* No
  mechanism opinion.
- #50729 (M3) — the one that **did** merge — was member-authored and got real review from `tdoublep`
  (APPROVED) and `njhill` (APPROVED). That is what the review pipeline looks like when maintainers
  believe a fix.
- #43559 was auto-closed by #51113's merge one second after it landed; #51113's own body says "This
  PR does not close #43559 on its own."

`dmih`'s summary ([#43559, 2026-07-20](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5023530631))
is a fair read of the state: *"there was PR that kind of fixing this, but instead several other PRs
we merged that are approximately on the same topic, with a vibes that maybe this will fix this.
Turned out that not. Now we have kind of abandoned real fix PRs … so what's next?"*

---

## 6. Throughput numbers with MTP + prefix caching

Everything found, with provenance. **Bold = MTP with concurrency > 1.** All are first-hand unless
noted.

| # | Source | Patch? | GPU | Model / quant / KV | Conc. | MTP k | Metric | Figure |
|---|---|---|---|---|---|---|---|---|
| **T1** | [`gjc1202`, #47194, 2026-08-26](https://github.com/vllm-project/vllm/issues/47194#issuecomment-5428414951) | **none** (stock v0.28.0) | 2× RTX 3090 NVLink, TP=2 | **Qwen3.8-27B W8A16 GDN/Mamba**, fp8_e4m3 KV, align, `--prefix-match-unit 16` | 1 / **10** | 3 | single-stream decode; **10-way aggregate**; acceptance; warm TTFT (60k prompt); KV pool | 55.5 → **81.7 tok/s (+47%)**; **210.1 → 388.3 tok/s (1.85×)**; acceptance 55.5% → 59.0%; warm TTFT 0.55 s → **1.89 s (3.4×)**; KV pool −13.9% | 
| **T2** | [`zack041`, #43650 body, 2026-05-26](https://github.com/vllm-project/vllm/pull/43650) | **#43650** | 1 GPU, TP=1 | Qwen3.5-35B-A3B-FP8 | `--max-num-seqs 256`, gsm8k 500 q | 2 | output tok/s (gsm8k) | no-MTP+APC **1640.4**; MTP+APC unpatched **2493.9**; **MTP+APC patched 1982.5** ⇒ the patch costs **−20.5%** of MTP throughput |
| T3 | [`zack041`, #43650, 2026-05-28](https://github.com/vllm-project/vllm/pull/43650#issuecomment-4567897026) | none | as T2 | as T2 | as T2 | 2 | output tok/s, non-cherry-picked | MTP+APC: **2152.6 / 2796.9 / 2844.0**; MTP no-APC: **1520.8 / 1595.1 / 1520.8** |
| **T4** | [`Suppressor72`, #53670, 2026-08-25](https://github.com/vllm-project/vllm/issues/53670) | none; + a drop-disable ablation | **2× RTX 5090, TP=2** | **Qwen3.8-27B FP8, fp8 KV**, block 1648 | **c=8** | dflash K=7 (states mtp also reproduces) | aggregate tok/s, 32k identical prompt ×4 rounds ×8 sessions | no-spec **327**; spec **206 (−37%)**; **drop disabled 322 (−1.6%)**; consumer-aware fix **304**; unique prompts (no reuse) spec **150.7** vs no-spec **255.8** |
| T5 | [`jschmied`, #53670, 2026-08-26](https://github.com/vllm-project/vllm/issues/53670#issuecomment-5421626023) | none | GB10 (sm_121) | **Qwen3.8-27B NVFP4, fp8 KV**, FlashInfer | 1 (6-turn agent loop) | 3 | hit rate; TTFT turns 2+ | no-spec 69.4% / **0.66 s**; **MTP k=3 42.5% / 2.04 s**; dflash2 43.3% / 1.93 s. Block size tracks depth: 1568/1600/1648 at K=0/3/7 |
| **T6** | [`jschmied`, #53670, 2026-09-04](https://github.com/vllm-project/vllm/issues/53670#issuecomment-5539850703) | **#53388** `disable_eagle_block_drop` | GB10 | Qwen3.8-Flash-Next, main `0.28.1rc1.dev352` | 1 (8-turn loop), batch 4096 | 3 | warm-turn latency; hit tokens; acceptance; s/turn | 2.05 s → **1.52 s (−26%)**; 4,800 → **6,400** hit tok; acceptance 56.1/53.3/53.8% → **59.5/57.5/60.0%**; 2.75/2.49/2.51 → 2.15/2.11/2.10 s/turn |
| **T7** | [`estrella159`, #43559, 2026-07-07](https://github.com/vllm-project/vllm/issues/43559#issuecomment-4907455987) | **#47861** | RTX PRO 6000 Blackwell, TP=1 | Qwen3.6-27B-FP8 and 35B-A3B-FP8, fp8 KV | 1 vs **8** | 2 | per-position acceptance; median task latency | acceptance **~99% single-stream → ~65% at concurrency-8** (27B), ~87% (MoE); **median task latency rose 9.1 s → 9.5 s with MTP on**; "MTP was net-slower on concurrent tool-calling" and pushed the GPU into power-cap throttling |
| T8 | [`noonghunna`, #43559, 2026-07-17](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5005615476) | **#48375** on v0.25.1 | 2× RTX 3090, TP=2 | Qwen3.6-27B hybrid, 13K held prefix | not stated | 3 | warm TTFT 2×2 | prefix-ON: MTP n=3 **1,314 ms** vs spec-off **523 ms**; prefix-OFF 13,285 / 12,878 ms. "**~92% of the penalty is the dropped-block re-prefill.**" Corroborated on a 2nd rig (26.7K prefix): 1,335 vs 709 ms. Accept-len 3.2–3.9 |
| **T9** | [`johny-jose`, #53919, 2026-08-26](https://github.com/vllm-project/vllm/pull/53919) | **#53919** | 1× H200 | **Qwen3.8-27B-FP8**, APC | **1 / 8 / 32 / 64 / 128** | 3 | tok/s, RAG-shaped prompts | baseline **58.6 / 220.3 / 347.4 / 436.8 / 487.8**; patched **56.6 / 221.5 / 354.6 / 413.4 / 482.1**; `--no-async-scheduling` **55.5 / 221.4 / 330.7 / 423.7 / 466.3**. Patch costs 1.2% at the knee vs 4.4% for async-off |
| T10 | [`thagraybush`, #43559, 2026-07-20](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5024198444) | none | DGX Spark GB10 | Qwen3.6-35B-A3B-FP8-dynamic, Triton backend | production agentic (unstated) | 2 | t/s | MTP off **43 t/s** → MTP on **62.6 t/s (+29%)** |
| T11 | [`amittell`, #43559, 2026-07-26](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5081557274) | none | **RTX 5090** (`--enforce-eager`); and a production Blackwell | **Qwen3.6-27B Unsloth NVFP4** | 1 | 3 | single-stream t/s; acceptance | 5090: MTP on **33.5–39.8 t/s**, MTP off **20.2–21.5 t/s** (dropping MTP costs 40–45% of decode). Production Blackwell: **91 t/s**, **acceptance 71% at 3 draft tokens (2.14 accepted/draft)** over ~430k drafted tokens |
| T12 | [`YuYue1208`, #48815 body](https://github.com/vllm-project/vllm/pull/48815) | **#48815** | unstated | Qwen3.5 MTP deployment | unstated | unstated | cached tok, TTFT, decode | 6,336/8,339 cached @ ~1.18 s TTFT → 8,448/8,525 @ ~235 ms; **decode ~102 tok/s, unchanged** |
| T13 | [`ptorsten`, #53802 body](https://github.com/vllm-project/vllm/pull/53802) | **#53802** | 2× DGX Spark | Qwen3.8-27B hybrid + **DFlash2** (not MTP) | unstated | — | tool-bench decode; TTFT | **~139 tok/s before and after**; 132k doc divergent-tail resubmit ~0% → **98%** hits, TTFT **78 s → 2.6 s (30×)**; 300k doc 97% hits, **227 s → 10.4 s** |
| T14 | [`tobymao`, #54713 body](https://github.com/vllm-project/vllm/pull/54713) | **#54713** | 4× DGX Spark, TP=4 | GLM-5.3-Flash | unstated | 3 | hit tok; TTFT | 8,901-token resend: 0 → **4,608** hit tok; warm TTFT **2.66 s** vs cold 5.88 s |
| T15 | [`YashasRattehalli`, #43559, 2026-07-22](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5044167958) | none (MTP removal) | A100-80G-PCIe | Qwen3.6-27B AWQ W4A16 | ~1–2 req/s sustained | 3 | p50 latency | dropping MTP **improved** p50 under concurrency: **3.66 s → 2.68 s** (short 30–130-token outputs) |
| T16 | [`sudeposutemizligi`, #43559, 2026-07-20](https://github.com/vllm-project/vllm/issues/43559#issuecomment-5023611725) | none | unstated | unstated | unstated | unstated | decode tps | "disabling mtp nearly **halved the decode to 50 tps**" ⇒ ~100 tps with MTP. Uncontrolled |

### 6.1 The `seanyourhighness` soak: token counts, no wall clock

[#48375, 2026-08-20](https://github.com/vllm-project/vllm/pull/48375#issuecomment-5358310314) —
**RTX 5090, Qwen3.8-27B NVFP4, NVFP4 KV, MTP-3, async scheduling, prefix caching + chunked prefill,
with the drop_eagle_block fix applied.** This is the single closest configuration match to this
stack, and **no throughput rate is derivable from it.** He reports:

- 58 requests, **1,461,705 prompt tokens**, **33,230 generated tokens**
- max observed concurrent streams: **7**
- MTP draft acceptance: **71.1%**
- peak KV utilisation 81%, mean TTFT **2.8 s**
- prefix-cache hit rate ~55%
- zero HTTP 500 / FSM / grammar / OOM / preemption / output-correctness failures

**No duration is given for the soak**, so neither prompt-token/s nor output-token/s can be computed
from 1,461,705 and 33,230. The one rate that *is* derivable is from his separate stress test:

> A separate seven-decode + one-prefill stress test processed a **120K-token prefill in 35.3 s**
> while the maximum decode gap stayed at **0.95 s**.

⇒ **120,000 / 35.3 = 3,399 prompt tokens/s** of prefill, concurrent with 7 decode streams. And the
0.95 s max decode gap bounds worst-case per-stream ITL, i.e. **≥ 1.05 tok/s floor per stream** during
that prefill — a tail-latency bound, not a throughput figure. Disclosure on the comment: *"AI-assisted
analysis and comment posting; the runs and measurements were produced and verified by me on the
hardware described."*

### 6.2 One derived rate, with its assumption stated

T6 (`jschmied`, today) gives seconds-per-turn but not tok/s. He states each turn "appends ~130
tokens to a ~7.5k-token shared prefix". **If** the model's own reply is the bulk of those ~130 tokens
and turn time is TTFT + decode, then warm turns run at roughly **130 / 2.05 ≈ 63 tok/s** with the
drop on and **130 / 1.52 ≈ 86 tok/s** with `disable_eagle_block_drop: true` — a ~35% end-to-end
speedup on Qwen3.8-Flash-Next at MTP n=3. **Labelled inference**: the ~130 is his description of the
appended text (reply *plus* a new question), so this is an upper-ish bound on the implied rate and
should not be quoted as a measurement.

### 6.3 What is missing, and it is the number the user wants

**No report anywhere in this cluster gives tok/s at concurrency > 1 with MTP + prefix caching on an
RTX 5090 with Qwen3.8-27B NVFP4.** The closest four each miss one axis:

- T1 (`gjc1202`) — right model class, right MTP, **concurrency 10** — but 2× RTX 3090 W8A16, and
  **unpatched**.
- T4 (`Suppressor72`) — right GPU (2× 5090), right model, **c=8**, and it includes a *drop-disabled
  ablation* — but FP8 not NVFP4, and the spec method is DFlash K=7.
- P8/§6.1 (`seanyourhighness`) — exactly right GPU + model + quant + patch + 7 streams — **no wall
  clock**.
- T9 (`johny-jose`) — a full concurrency sweep on Qwen3.8-27B-FP8 with MTP — but H200 and it measures
  #53919, not #43650.

**The best available estimate of what MTP buys at batch on this model class is T1: 1.85× aggregate
throughput at 10-way concurrency (210 → 388 tok/s), measured on unpatched v0.28.0.** The best
available estimate of what the eagle block drop *costs* at batch is T4: **−37% aggregate at c=8**,
of which the drop accounts for essentially all of it (322 vs 327 with the drop disabled).

---

## 7. What would settle it, cheapest first

1. **Run a nightly with MTP on and `--no-async-scheduling`, and count.** This is the arm the
   evidence actually supports: nightly carries merged #50729 (M3), which two reporters confirm on
   this symptom (E1, E2); `--no-async-scheduling` statically removes M4's code path (§4.4, verified
   at `vllm/config/vllm.py`), the mechanism with the strongest fix evidence (E3) and no merged fix.
   No patched file, no bind mount. Cost per T9: ~4.4% at the throughput knee.
2. **If you do apply #43650, instrument `vllm:prefix_cache_hits_total` in both arms.** Per N2, a
   clean result with a collapsed hit rate is the known false positive, and per §4.1 this build is the
   one where collapse is most likely. If hits go to ~0 you have bought a slow non-fix.
3. **Run `heheda12345`'s discriminating test, which nobody has run in 15 months.** "for linear
   attention, add another linear attention state f(0)=0, f(i)=f(i-1)+1, and check whether the hit
   f(i) == i." It answers "is M2 real on this build" directly, in a unit test, with no soak.
4. **Run `raoulprevost`'s v3 probe** (A → B → A with the same 20 tools;
   [gist](https://gist.github.com/raoulprevost/6823cfde04df73f7778a343be73c7e74)). It is the only
   deterministic reproducer in the cluster, it was validated on **RTX 5090 + Qwen3.6-27B-NVFP4**, and
   per `amittell` (N7) it is the shape that catches this when stable-cache hit-vs-miss comparisons do
   not. Note `cduk` and `estrella159` got non-repros with it, so a clean result is weak; a dirty one
   is strong.
5. **Disambiguate the `qwen3_coder` → `qwen3_xml` parser confound** (R2 §2.2) before attributing
   anything to MTP. Note that #47194's OP, `andysalerno` (P2), `dmih`, and `eblanshey` all ran
   `qwen3_coder` while reporting `<tool_call>` leakage.

---

## 8. Release / image status as of 2026-09-04

- **No v0.28.1 release.** GitHub releases: latest is `v0.28.0` (2026-08-26). Tags containing
  "0.28": `v0.28.0rc1`, `v0.28.0rc2`, `v0.28.0`, **`v0.28.1rc0`** — no `v0.28.1`, no `v0.28.1rc1`
  tag (the `0.28.1rc1.devNNN+g…` strings reporters quote are nightly build versions, not tags).
  `ionut-anghelina` asked for a 0.28.1 date twice (2026-08-31); unanswered.
- **No v0.28.1 Docker image.** Docker Hub `vllm/vllm-openai` (578 tags, all pages scanned for
  `^v0.2[78]`): the newest release-tagged images are `v0.28.0*`. Daily `nightly-<sha>` /
  `cu129-nightly-<sha>` continue; latest at time of writing
  `nightly-8a728663c1c3eeace834a95f5654fa653cc1998c` (2026-09-04T06:18Z). This is unchanged from
  2026-09-03.
- **Nothing in the M2 cluster has merged.** Re-verified today: #43650 (`blocked`), #48375 (`dirty`),
  #48815 (`dirty`), #51351 (`dirty`), #52371 (`blocked`), #53479 (**draft**, `dirty`), #53802
  (`blocked`), #53945 (`blocked`, `ready`), #54163 (`blocked`), #54165 (`dirty`), #54713
  (`blocked`, DCO `action_required`) — all open. #53919 (M4) open, `blocked`.
- **What *did* merge in this area since 2026-08-25** (`gh api repos/.../commits?path=vllm/v1/core/single_type_kv_cache_manager.py`):
  `52707` (2026-08-28, negative external block allocation), `51358` (2026-08-29, Mooncake exact mamba
  boundary states), `53896` (2026-08-31, Qwen3.8-Flash-Next model support), `53598` (2026-08-31,
  DSpark DCP), **`53388` (2026-09-01, `disable_eagle_block_drop`)**, `52832` (2026-09-01),
  `53906` (2026-09-03, GLM-5.3-Flash), `51886` (2026-09-04, offloading retention interval).
  **The only one that changes MTP + prefix-cache behaviour is #53388, and it goes the opposite way
  from #43650.**
- **#53505 closed as completed 2026-08-30** by #54165 per its reporter's 24 h production
  confirmation (E4) — but that is the DFlash/DSpark misclassification path, not MTP.

---

## 9. Verdict, restated for the decision

For the question actually asked — *will applying the open `drop_eagle_block` fix let this stack run
MTP + prefix caching + batching on Qwen3.8-27B NVFP4 without mojibake, leaked tool XML, malformed
tool calls, degenerate generations, and empty-content EOS?* — the honest answer is:

**Unproven, and the strongest single reason is not doubt about the reports but a source-level fact:
the patch that was confirmed in June is not the patch you would be applying today.** #46384 changed
the caller on 2026-07-12; every confirmation of #43650 predates that by five weeks; and the same six
lines now over-correct by one full mamba block, in a code path that five separate open PRs and one
*merged* feature exist to stop over-correcting.

Meanwhile the two mechanisms with clean before/after corruption counts on this exact model family —
M3 (#50729, merged, in every nightly, 12/5000 → 0/5000) and M4 (#53919, open, 29/1248 → 0/1248,
p=1.6e-9, gated on async scheduling which MTP turns on by default) — are both reachable without
patching a single file: upgrade the image, and pass `--no-async-scheduling`.
