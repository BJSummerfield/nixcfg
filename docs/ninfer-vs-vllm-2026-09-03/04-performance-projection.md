# 04 — Performance projection: NInfer under *this* stack's workload

Agent R3. Written 2026-09-03. Inputs: `01-baseline-vllm.md` (S1), `02-ninfer-architecture.md`
(R1), `03-mtp-prefix-cache-correctness.md` (R2), and
`docs/local-llm-review-2026-09-01/01-measurements.md`.

Where I needed numbers none of those three carried (KV bytes/token, StateImage bytes, the
admission reservation formula) I read NInfer source directly at the same HEAD R1 used,
`a140e7ae`, from the clone R1 left at `/tmp/ninfer`. Those are labelled **published-theirs**
(their docs) or **inferred** (my arithmetic over their source constants), never
*measured-ours*.

**I do not contradict S1, R1 or R2 anywhere.** I extend R1 §1.1 (the prefill/decode
alternation cost) with a duty-cycle model, and I add one fact none of the three had: NInfer's
admission **reserves prompt + max_tokens**, not prompt + actual output. That single fact drives
most of the concurrency answer.

## Provenance key

| Label | Meaning |
| --- | --- |
| **measured-ours** | From S1's `/metrics` scrape or the 09-01 measurements. Ours, on our traffic. |
| **published-theirs** | Printed in NInfer's own `docs/performance.md` / `README.md`. Their box, their fixtures, prefix reuse **disabled**, INT8 KV. |
| **inferred** | My reasoning. Basis shown inline. |

---

## 0. Headline table

Workload: interactive agentic coding, 56:1 in:out, ~64,176-token mean worker turn
(**measured-ours**), 102,400 `maxModelLen`, RTX 5090 31 GiB. NInfer column assumes
`--max-concurrency 4`, `--kv-dtype fp8`, `--max-context 102400`, MTP3 on (see §3 for why C=4
and not C=8). "Range" is honest uncertainty, not a confidence interval.

| Metric | vLLM measured | NInfer projected (range) | Basis | Confidence |
| --- | ---: | ---: | --- | --- |
| **Per-stream decode, no spec decode** (≈64k ctx) | **51.2–53.4 tok/s** (measured-ours) | **60–70 tok/s** | published-theirs 65.7 ± 0.8 @64,512 ctx, discounted for INT8→fp8 KV and idle-box vs. production mix | **High** — closest thing to a like-for-like point in the whole study |
| **Per-stream decode, MTP3 on** | n/a today; **~100 tok/s** on 09-01 with MTP (measured-ours, different soak) | **135–180 tok/s** | inferred: their 64k MTP0 round cost 15.2 ms × their measured MTP3 round overhead 1.21× → 18.4 ms/round, × 2.65–3.2 tokens/round at 55–72% acceptance | **Medium** |
| **TPOT** | **18.72 ms** ITL / 19.55 ms req (measured-ours) | **14.3–16.7 ms** MTP0 · **5.6–7.4 ms** MTP3 | inferred, reciprocal of the two rows above | Medium / Medium-low |
| **Prefill compute rate @64k** | **5,378.8 tok/s** (measured-ours, mixed lengths, fused with decode) | **5,000–5,500 tok/s** | published-theirs 5,297.9 ± 259 @64,512 ctx | **High** — this is a wash, ±5% |
| **Prefill effective rate** (prompt tok / prefill s) | **30,286 tok/s** (measured-ours) | **15,000–36,000 tok/s** | inferred: 54,765 mean prompt ÷ projected prefill time at reuse hit rate *h* = 0.55–0.90 (§2) | **Low** — the whole range is *h* |
| **Prefix-reuse hit rate** | **82.2%** partial-match radix (measured-ours) | **55–85%**, bimodal (§2) | inferred; NInfer's exact-frontier scheme, pi's request shape, catalog/pool bounds | **Low** — the single most uncertain number here |
| **Computed prefill tokens/request** | **9,726** (measured-ours: 15,347,999 ÷ 1,578) | **9,000–28,000** | inferred: h×(delta ≈3k) + (1−h)×54,765. NInfer must beat h≈0.87 just to *match* vLLM here (§2.4) | Medium |
| **TTFT median** | **≈0.49 s** (measured-ours, 52.1% ≤ 0.5 s) | **0.5–1.2 s** | inferred: host checkpoint restore 60–120 ms + 2–4k delta prefill + alternation tax | Medium |
| **TTFT mean** | **3.300 s** (measured-ours) | **2.5–10 s** | inferred; straddles the measured value, dominated by *h* | **Low** |
| **TTFT p95** | **≈20 s** (measured-ours, 95.1% ≤ 20 s) | **25–70 s** | inferred: single-lane prefill + no preemption + 94k-token reservations blocking admission (§4, §5) | Low |
| **Effective concurrency at our turn size** | **3** (measured-ours: `maxNumSeqs`=3 binds; pool would allow 211,911/65,500 ≈ 3.2) | **2** | inferred, §3 arithmetic. `kv_cache_max_concurrency` 2.069 is vLLM's *worst-case* figure at `maxModelLen`, not what it achieves at 64k turns | **High** — arithmetic from their own source constants |
| **`--max-concurrency 8` usable?** | n/a | **No.** Startable, delivers **1** concurrent pi turn | inferred, §3. C=8's own 2.29 GiB StateImage allocation shrinks the KV pool below 2× our reservation | **High** |
| **Aggregate decode at achievable batch** | **~104 tok/s** at 2 streams (inferred from measured-ours: 09-01 shows 1→2 concurrent is free) | **122 tok/s** MTP0 · **270–330 tok/s** MTP3 | inferred: 2 streams × per-stream × 0.93 batching cost (published-theirs C2/C1 ratio) | Medium |
| **Requests hitting the queue deadline** | **1.1%** exceed 30 s of queue today (measured-ours) | **2–8% would 503/504** at `--pending-timeout-ms 30000` | inferred, §5. Config trap, not architectural — the flag is settable | Medium |
| **Batch-makespan speedups (C=4 2.83×, C=8 5.33×)** | — | **Inapplicable.** Our time-averaged occupancy is **0.82 requests** (measured-ours: 40,373 s inference ÷ 49,463 s uptime) | inferred, §6 | High |

**One-line summary.** NInfer's plausible win is **decode speed** (+15–30% without spec decode,
2.6–3.4× with MTP3, which vLLM cannot safely run today per R2). Its prefill rate is a wash, its
achievable concurrency at our context length is **the same as or worse than** vLLM's, and its
TTFT tail is probably worse. Everything downstream of that depends on a prefix-reuse hit rate
nobody has measured.

---

## 1. What "our workload" means numerically

All **measured-ours**.

| Quantity | Value | Source |
| --- | ---: | --- |
| Mean prompt tokens/request | 54,765 | S1 §4: 86,419,167 ÷ 1,578 |
| Mean input per *worker turn* | 64,176 | 09-01 §1 |
| Mean output tokens/request | 1,270 | S1 §3: 2,004,034 ÷ 1,578 |
| Input:output | 56:1 | 09-01 §1 |
| Prefix-cache hit rate | 82.2% | S1 §5 |
| Computed prefill tokens/request | 9,726 | S1 §4 |
| Prefill wall-time share of engine uptime | 5.77% | S1: 2,853.4 s ÷ 49,463 s |
| **Time-averaged requests in flight** | **0.82** | S1: `request_inference_time_seconds_sum` 40,373 ÷ uptime 49,463 |
| Requests arriving with ≥3 in flight | 55.0% | 09-01 §3 |
| Peak observed in flight | 16 | 09-01 §3 |
| Queue >30 s | 1.1% | S1 §2 (98.9% ≤ 30 s) |
| Worst observed queue wait | 480 s (09-01 soak) / 60–120 s (current soak) | 09-01 §2 / S1 §2 |

### 1.1 pi's per-request KV entitlement is a constant, and it is huge

`modules/pi-coding-agent/settings.nix:40`: `contextWindow = maxModelLen − headroom` = 102,400 −
4,096 = **98,304**. `maxTokens = 32768`. pi then clamps
`max_tokens = min(32768, contextWindow − input − 4096)` (09-01 §6, quoted from
`simple-options.js`).

So for **any turn whose input exceeds 61,440 tokens** — which is most of them —

```
prompt + max_tokens  =  contextWindow − 4096  =  94,208 tokens, exactly, independent of input
```

**This number is the hinge of the whole concurrency analysis** (§3). It is *not* the 65,446
tokens the request actually touches (64,176 in + 1,270 out); it is 44% larger, and the
difference is output budget that is never generated.

---

## 2. The prefix-reuse hit rate — the most important and most uncertain judgement

### 2.1 Why our 82.2% does not transfer

Our 82.2% is a **vLLM** number produced by a **partial-match radix cache over 1568-token
blocks** (S1 §7). NInfer's reuse is categorically different (R1 §2.1, quoting
`resource-scheduling-and-context-cache.md:243-253`): a hit requires a **complete StateImage at
an exact token frontier**, with token IDs, positions/MRoPE, vision spans and template mode all
matching exactly. Their own words: *"When only tokens match, or only KV bytes or pages match,
what is missing is a complete continuation, not a partial cache hit."*

Two consequences pull in opposite directions and both are real:

- **Against NInfer:** a partial match is a *miss*, so misses cost the whole prompt, not the
  unmatched suffix.
- **For NInfer:** a hit carries the **recurrent state** as well as KV, at any frontier — vLLM's
  mamba cache only publishes at block boundaries and (with EAGLE on) backs off a whole block
  (R2 §1.3). And NInfer publishes **six** frontiers per continuation, not one, so a mismatch
  degrades in *steps* rather than to zero.

### 2.2 pi's request shape against exact-frontier reuse — what hits and what misses

pi resends the whole conversation each turn: stable system prompt, then
`user → assistant(+tool calls) → tool results → …`, appending each turn.

| pi behaviour | NInfer frontier that catches it | Verdict |
| --- | --- | --- |
| Turn *N+1* = turn *N*'s prompt + turn *N*'s assistant output + tool result | `private_endpoint` — "latest continuable state of a completed request in this session" (R1 §2.2) | **Hit, ~98% of the prompt**, *if* pi's re-render of the assistant message is token-identical to what the model emitted |
| pi re-renders assistant tool calls from its own structured JSON (member order, injected defaults) | falls back to `private_turn_closure` — "stable state *before* the replaceable assistant suffix" | **Graceful degrade.** Loses only the ~1,270 assistant tokens + tool result. Still ~97% reuse. This fallback frontier exists *precisely* for this case |
| Stable system prompt shared across all agents of a type | `shared_stable_prefix` | Small hit (~3–8k of 64k) even on a total session miss |
| pi compaction fires at `contextWindow − reserveTokens` = 81,920 | nothing — history is rewritten | **Root miss**, full cold prefill. ~1 turn in 15–25 (inferred from turn growth vs. the 81,920 threshold) |
| `reasoning_effort` changes mid-session | invalidates identity (R1 §2.3, `serving.md:993`) | Miss. We do run effort tiering |
| pi fans out to N concurrent subagent sessions, each with its own 64k history | each needs its own checkpoint slot **and** its own retained KV pages | **The binding constraint — see §2.3** |

### 2.3 The capacity ceiling on reuse, which is what actually caps *h*

At `--max-concurrency 4` and fp8 KV the Main pool is **~217,000 tokens** (§3 arithmetic,
**inferred**). Our reservation is 94,208. One retained 64k checkpoint costs ~64,500 tokens of
that same shared pool (R1 §3.2: *one* pool serves active requests and retained prefixes).

```
2 active requests        = 188,416 tokens  →  ~29,000 left: no room for a 64k checkpoint
1 active + 1 checkpoint  = 158,700 tokens  →  fits
```

**At our prompt size you can have two active requests, or one active request and one retained
device checkpoint. Not both.** Every reuse therefore comes from the **pinned-host tier**, and
its size is the real lever:

| Setting | Host KV | 64k checkpoints retainable | StateImage slots |
| --- | ---: | ---: | ---: |
| default `--host-kv-mib 8192`, `--host-state-slots 8` | 8 GiB | **≈3.6** | 8 |
| `--host-kv-mib 32768 --host-state-slots 24` | 32 GiB | ≈14.6 | 24 |

Restore cost per hit, **inferred**: 64,512 tokens × 34.3 KiB = **2.16 GiB** over PCIe, plus one
146.8 MiB StateImage. At pinned-host PCIe 5.0 rates (~20–40 GB/s) that is **60–120 ms** — versus
a 12.3 s cold prefill. The host tier is cheap and it is the one capability vLLM has no
equivalent of for hybrid models. Host RAM on redtruck: **not determinable from this repo**;
this lever is only real if the box has the RAM.

### 2.4 The estimate

| Scenario | Projected *h* | Reasoning |
| --- | ---: | --- |
| **Render identity fails** (pi's tool-call re-render never matches, and the `turn_closure` fallback also misses) | **5–15%** | only `shared_stable_prefix` survives. R1 flags HEAD commits `a140e7ae "preserve exact agent prefix reuse"` and `719d56ef "preserve structured tool call intent"` as fixes landed *on the day of this study* in exactly this path — i.e. it was broken until 2026-09-03 |
| **Defaults** (`--host-kv-mib 8192`, `--max-private-continuations 2C`=8) | **25–55%** | render identity holds, but with 3–8 live pi sessions each holding 64k of history and room for ~3.6 host checkpoints, a session's checkpoint frequently does not survive to its next turn |
| **Tuned** (`--host-kv-mib 32768`, `--host-state-slots 24`, `--max-private-continuations 24`) | **70–90%** | checkpoint survival becomes likely; per-turn within-session reuse is ~97–99%; residual loss is compaction resets and effort switches |

**I am publishing 55–85% as the headline range**, weighted toward the tuned case because the
tuning flags are free, with the explicit warning that the distribution is **bimodal, not
Gaussian**: the render-identity question is close to binary, and if it goes the wrong way the
answer is ~10%, not "the low end of 55%."

### 2.5 The asymmetry that matters: NInfer needs a *higher* hit rate than vLLM

Because a NInfer miss costs the whole prompt while a vLLM miss costs only the unmatched suffix:

```
E[computed tokens] = h × delta + (1 − h) × 54,765          (delta ≈ 3,000, inferred)
```

| *h* | E[computed] | vs. vLLM's measured 9,726 |
| ---: | ---: | --- |
| 0.55 | 26,000 | **2.7× worse** |
| 0.70 | 18,500 | 1.9× worse |
| 0.85 | 10,800 | 1.1× worse |
| **0.87** | **9,700** | **break-even** |
| 0.95 | 5,600 | 1.7× better |

**NInfer must clear h ≈ 0.87 just to compute the same number of prefill tokens per request that
vLLM computes today at h = 0.822.** That is the cleanest statement of the exact-frontier
trade-off, and it is the number I would put in front of the decision.

---

## 3. `--max-concurrency`: does the arithmetic close at C=8?

**No.** C=8 starts, and then delivers *one* concurrent pi turn — fewer than C=2 or C=4.

### 3.1 Constants (all read from NInfer source at `a140e7ae`, **published-theirs**)

| Constant | Value | Location |
| --- | ---: | --- |
| Total layers / full-attention layers / GDN layers | 64 / 16 / 48 | `src/targets/qwen3_6_27b/impl/config.h:13`, `hybrid_topology.h` (1 in 4) |
| `kv_heads` / `head_dim` | 4 / 256 | `config.h:29-30` |
| GDN value heads × head dim × key head dim | 48 × 128 × 128 | `config.h:25-27` |
| `mtp_layers` | 1 | `config.h:44` |
| KV page size | 64 tokens | `src/core/paged_kv_cache.h:18` |
| Device StateImage slots | `C + device_state_slots`, **default `device_state_slots = C`** | `layouts_impl.h:96`; `include/ninfer/types.h:126-128` |
| CUDA graph allowance | 12 MiB × C | `layouts_impl.h:668` |
| NVFP4 weight arena | 19.729 GiB | `docs/performance.md:186` |
| `--kv-capacity auto` headroom | 1 GiB | `include/ninfer/types.h:46` |
| Legality | `max_context ≤ kv_capacity ≤ C × max_context` | `layouts_impl.h:582-598` |
| **Admission reservation** | **`prompt + effective_output − 1`**, `effective_output = min(max_tokens, capacity − prompt + 1)` | `request_plan_impl.h:255-269`; `docs/serving.md:960` |

**Derived, inferred:**

- KV bytes/token = 16 layers × 4 heads × 256 dim × 2 (K,V) = 32,768 elements.
  - INT8 group-64 (their benches): 32,768 B + 512 scales ≈ **33.0 KiB**
  - **fp8 E4M3 row-256 (ours): 32,768 B + 128 scales ≈ 32.25 KiB** — *2.3% smaller than INT8*
  - NVFP4 group-16: **18.0 KiB**
  - MTP3 adds one more full-attention layer's worth: +1/16. **fp8+MTP3 = 34.27 KiB/token.**
- StateImage = 48 × 48 × 128 × 128 × 4 B (FP32 recurrent) + conv BF16 + hidden = **146.8 MiB**
  (matches R2 §3.1's quoted "T × 146.8 MiB").

**Cross-check against their published point.** `docs/performance.md` states NVFP4 at C=8
resolved `--kv-capacity auto` to **187,712 tokens** on a 32 GiB card. Reconstructing:
19.729 (weights) + 1.0 (headroom) + 6.28 (KV @35.06 KiB) + 2.29 (16 StateImages) + 0.15
(graphs+replay) = 29.45 GiB, leaving **1.95 GiB** of workspace out of ~31.4 GiB usable. That is
a plausible workspace for this model, so the model reproduces their number. I carry the 1.95 GiB
workspace forward as a back-solved constant.

### 3.2 The sweep on *our* 31 GiB card, fp8 KV, MTP3

`KV budget(C) = 31.0 − 19.729 − 1.0 − 1.95 − C×(2×146.8 MiB) − C×(12+7 MiB)` GiB

| C | Main KV pool (tokens) | ÷ 94,208 reservation | **Concurrent pi turns** | C=8-style speedup applicable? |
| ---: | ---: | ---: | ---: | --- |
| 1 | 245,000 | 2.60 | **1** (lane-capped) | — |
| 2 | 236,000 | 2.50 | **2** | — |
| 3 | 227,000 | 2.41 | **2** | — |
| **4** | **217,000** | **2.31** | **2** | no |
| 6 | 199,000 | 2.11 | **2** | no |
| **8** | **180,000** | **1.91** | **1** | **no — two 94,208-token entitlements do not fit** |

All rows are legal at startup (`kv_capacity ≥ max_context` = 102,400 everywhere), so **the
process starts at C=8 and then silently serializes.** The scheduler will show `running=1`,
`waiting=k` — exactly the shape S1 caught on vLLM at `maxNumSeqs=2` on 09-01.

With **NVFP4 KV** (18.0 KiB/token, added 2026-09-01, unbenchmarked by anyone):

| C | pool | concurrent pi turns |
| ---: | ---: | ---: |
| 4 | 389,000 | **4** |
| 8 | 322,000 | **3** |

To actually fill 8 lanes you need a reservation ≤ ~40,000 tokens — a `max_context` around 40k,
which pi structurally cannot use (it clamps against `contextWindow`, and compaction fires at
81,920). **C=8 is unreachable at our context length under every KV dtype NInfer offers.** The
README's C=8 / 5.33× row is therefore **not applicable to this stack** and should not appear in
any comparison.

### 3.3 vLLM does better here, and the reason is structural

vLLM allocates KV blocks **on demand** as tokens are produced. A pi turn touches 64,176 + 1,270
≈ 65,500 tokens, so vLLM's 211,911-token pool holds **3.2** of them and `maxNumSeqs=3` is what
binds (**measured-ours**, S1 §7 + 09-01 §3). NInfer **reserves the entitlement**, 94,208, and
holds **2**.

`kv_cache_max_concurrency = 2.069` is vLLM's *worst-case* self-report (pool ÷ `maxModelLen`,
S1 §7). Against NInfer, the fair comparison is 3 vs 2, not 2.07 vs 8.

**Actionable, and it only helps NInfer:** lowering pi's `maxTokens` from 32,768 to ~4,096 cuts
the reservation from 94,208 to ~68,300 and raises NInfer's concurrent turns from 2 to **3** at
C=4 (fp8) or 4→5 (nvfp4). It does nothing on vLLM, which never reserves the unused budget. This
is the single cheapest NInfer-side tuning lever and it is a `models.nix` one-liner.

---

## 4. Prefill and decode never co-run — the size of the penalty

R1 §1.1 established the mechanism from `scheduler.h:239-246`: when both are runnable the engine
**strictly alternates**, one prefill chunk then one decode round. Prefill is additionally
**single-lane** (`scheduler.h:259-263` throws if two requests own staged prefill).

### 4.1 Duty cycle (inferred, from published-theirs rates)

| Quantity | Value | Basis |
| --- | ---: | --- |
| One 1,024-token prefill chunk @64k ctx | **193 ms** | 1024 ÷ 5,297.9 tok/s (published-theirs) |
| One MTP0 decode round @64k ctx | **15.2 ms** | 1 ÷ 65.7 tok/s (published-theirs) |
| One MTP3 decode round @64k ctx | **18.4 ms** | inferred, §7.1 |
| **Decode duty cycle while any lane prefills** | **7.3% (MTP0) / 8.7% (MTP3)** | 15.2/(193+15.2) |

**A decoding stream runs at 7–9% of its solo rate for as long as any other lane is prefilling.**
vLLM fuses prefill chunks and decode tokens into one forward pass with
`--max-num-batched-tokens 4096`, so its decode streams keep running (the 3 decode tokens ride
along in a 4,096-token batch). Our measured TTFT 3.30 s and TPOT 18.72 ms already include that
fusion.

### 4.2 What it costs us, per case

| Case | Effect |
| --- | --- |
| **Median turn** (hit, ~3k computed): 3 chunks = 0.58 s | co-running stream loses ~35 tokens ≈ 0.2 s. **Negligible.** |
| **Cold turn** (root miss, 64k): 63 chunks = 12.2 s prefill work | prefiller's own TTFT +9.5% → **13.4 s**; a co-running decode stream advances **180 tokens instead of ~2,300**, i.e. loses ~11.6 s of progress |
| **Aggregate throughput** | our prefill duty cycle is 5.77% of wall time (measured-ours). If NInfer computes 1.0–2.9× our prefill tokens (§2.5), its duty cycle is 5.8–16.7%, and aggregate decode loss = duty × 0.92 ≈ **5–15%** |
| **Burst of *k* cold requests** | prefill is single-lane, so their prefills **serialize**. Three cold 25k-token turns arriving together: the third waits ~3× its own prefill ≈ 15–20 s before its first token. vLLM chunks all three concurrently inside the 4,096-token budget |

**Verdict:** on the *mean* this is a 5–15% aggregate decode tax — real but not disqualifying,
and much smaller than R1's §1.1 worst case suggested, because 82%-style reuse keeps mean
computed prefill down to single-digit thousands of tokens. **On the p95 TTFT it is the dominant
term**, and it is exactly the effect no NInfer benchmark can show: their MTP0 campaign is
one-request-at-a-time, and their MTP3 saturation campaign uses **293-token prompts** where
prefill is 0.03 s.

**The knob:** `--prefill-chunk` is settable down to 128 (multiple of 128 enforced). At 256
tokens/chunk the decode duty cycle rises to ~28%, but prefill efficiency falls by an amount
nobody has measured — their 5,297.9 tok/s figure is at chunk 1024. **Not determinable without a
bench.**

---

## 5. Queue behaviour: 429s, 503s, or fine?

R1 §1.5: bounded FIFO, **never preempts**, `outstanding_ ≥ C + max_pending_requests` → **429**
(**529** on the Anthropic endpoint), absolute `pending_timeout_ms` deadline → **503** (**504** on
Anthropic). Defaults: `max_pending_requests = 16`, `pending_timeout_ms = 30000`. The deadline
starts **before** preparation, and `outstanding_` counts requests in CPU/media prep and
completed-but-unreleased results.

| Failure | At NInfer defaults, C=4 | Projection |
| --- | --- | --- |
| **503/504 on the 30 s deadline** | 1.1% of current-soak requests already queue >30 s on vLLM (**measured-ours**, S1 §2); the 09-01 soak reached **480 s**. NInfer's queue waits will be *longer* — 2 concurrent instead of 3, single-lane prefill, one admission per boundary, no preemption | **2–8% of requests would fail.** Unacceptable as-is |
| **429/529 on the 20-request cap** (C=4 + 16 pending) | our tail reaches **16 in flight** (measured-ours, 09-01 §3), and `outstanding_` over-counts | **Occasional, in fan-out bursts.** Not routine |
| **`ContextLengthExceeded` rejection** | a request whose reservation can never fit is *failed*, not queued (R1 §1.4, `engine_core.h:1692`). Our reservation is 94,208 ≤ pool at every C | **Does not fire** — but it *would* if the pool ever shrank below 94,208 (i.e. C≥12 if the cap allowed it) |

**Both are config traps, not architectural limits.** `--pending-timeout-ms 600000` and
`--max-pending-requests 48` remove them. That must be in any deployment recipe, or the first
fan-out burst produces a wave of 504s that pi will surface as tool failures.

Worth noting on the other side: R1 §1.4 found NInfer's admission does head-of-line protection
with a **proof-carrying backfill** (`prove_persistent_backfill`), which is strictly better
starvation behaviour than vLLM's default scheduler. Our vLLM run shows **0.125
preemptions/request** (measured-ours, S1 §6) — NInfer would show zero, at the cost of the queue
waits above.

---

## 6. Why the makespan speedups are inapplicable

Their corpus-makespan campaign (C=4 → 2.83×, 432.9 tok/s aggregate) is a **closed loop**: C
persistent workers each submit the next request the instant the previous response lands, so
occupancy is pinned at C for the whole run (`docs/performance.md`, method section).

**Our time-averaged occupancy is 0.82 requests** (measured-ours: `request_inference_time_seconds_sum`
40,373.1 s ÷ uptime 49,463.4 s). The engine is idle or single-stream most of the time, with
bursts. A speedup measured at sustained occupancy 4 or 8 has almost no wall-clock surface to act
on here.

**The bound:** for interactive latency, what a user feels is (a) per-stream decode speed and
(b) queue wait. The makespan multiplier acts only on (b), and only during the minority of wall
time we are saturated. So:

> The honest upper bound on NInfer's interactive gain is its **per-stream** improvement
> (row 1–2 of §0), plus a burst-flattening term worth at most a few percent of mean latency.
> The 2.83× and 5.33× figures should not appear in a latency comparison at all.

This is the same shape as S1's warning that our own "aggregate decode 53.41 tok/s" is a
token-weighted per-stream rate, not batched throughput.

---

## 7. Decode: how I got 135–180 tok/s, and where our traffic sits on the acceptance curve

### 7.1 The round-cost model (inferred, fitted to published-theirs)

Their Qwen3.8-27B NVFP4 cross-scenario table gives decode rate *and* tokens/round for four
categories, so the MTP3 round cost falls out:

| Category | Decode tok/s | Acceptance | Tokens/round | Implied round cost | vs. MTP0 step (14.04 ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Structured | 219.8 | 90.8% | 3.72 | 16.9 ms | 1.21× |
| Code | 194.3 | 76.4% | 3.29 | 16.9 ms | 1.21× |
| Translation | 192.3 | 75.0% | 3.25 | 16.9 ms | 1.20× |
| Story | 126.1 | 37.4% | 2.12 | 16.8 ms | 1.20× |

The round cost is **1.21× a plain decode step, dead flat across acceptance** — which is what you
expect and is a good sign the table is internally consistent. Validating it at long context:
their `long_decode_aime26_15` fixture (65k tokens generated, 56.2% acceptance, 2.69
tokens/round) predicts 2.69 ÷ (15.22 × 1.21 ms) = **146 tok/s** against a published **151.4** —
3.5% error. Model accepted.

At 64k context: MTP0 step 15.22 ms → **MTP3 round 18.4 ms**.

### 7.2 Where pi's traffic sits on the 37–91% acceptance range

pi's output is a mix of: reasoning traces (thinking is on, with effort tiering), short prose,
and Qwen-XML tool calls carrying file paths and code. That maps to **Code (76.4%)** and
**Structured (90.8%)** for the tool-call and diff portions, and to the **long-reasoning fixtures
(56.2–76.0%)** for the thinking portion. It is emphatically *not* Story (37.4%).

The best anchor is not their table at all — **it is our own measurement.** On 09-01 this exact
model, this exact traffic, k=3 MTP: **67.9% acceptance, 3.04 tokens emitted per step**
(measured-ours, 09-01 §5, with per-position 80.7 / 66.6 / 56.4%). That sits squarely between
their Code and long-reasoning rows, which is the corroboration I would want.

**Discount applied.** NInfer's own Qwen3.8 acceptance runs consistently *below* vLLM's on
comparable content — 57.6–60.8% on their makespan corpus, 45.8–48.9% on their saturation
fixture. Candidate causes (all **inferred**, none verified): they sample at temperature 0.6 with
presence penalty 1.0 where we run temperature 1.0; and `--lm-head-draft`
(`ProposalHead::Optimized`) may trade acceptance for draft speed. So I project NInfer acceptance
on pi traffic at **55–72%**, i.e. our measured 67.9% shaded down, → **2.65–3.2 tokens/round** →
**144–174 tok/s**, widened to **135–180** for the round-cost model's own error.

### 7.3 The claim I trust least

The model implies NInfer's MTP3 round costs **1.21×** a plain step while vLLM's costs **~1.62×**
(from measured-ours: 09-01 TPOT 9.98 ms × 3.04 tokens = 30.3 ms/step, vs. 18.72 ms MTP-off
today). If true it is a large, real architectural advantage.

**But S1 states plainly that the 09-01 and 09-03 populations are different soaks with different
`maxNumSeqs`, pool size and traffic mix**, so 30.3 vs 18.72 is not a controlled A/B and the
1.62× is soft. I flag this as the single most likely place this projection is too generous to
NInfer. Confidence: **low-medium**. It does not change the MTP0 comparison (row 1), which stands
on its own.

### 7.4 The counterfactual that shrinks the whole win

R2 §6 recommends bumping vLLM to **v0.28.1** (which contains #50729, absent from our 0.28.0 and
confirmed by a reporter to fix this symptom) and re-enabling MTP. If that works, vLLM returns to
~100 tok/s per stream (measured-ours, 09-01) and NInfer's MTP3 advantage collapses from
**2.6–3.4×** to **1.35–1.8×** — against a stack we already run, package and trust. **That test
costs an hour and it dominates this entire comparison.** Same conclusion R2 reached, from the
performance side.

---

## 8. Corrections applied, itemised

| # | Correction | How it landed |
| --- | --- | --- |
| 1 | Old review quoted **Qwen3.6** prefill as Qwen3.8 | Used the 3.8 NVFP4 row throughout: 8,340 @7,680 → **5,297.9 @64,512 (12.28 s TTFT)** → 2,203 @260,096. The 64,512 row drives §0, §4 |
| 2 | **All** their benches ran with prefix reuse **disabled** | Their prefill numbers are worst-case. But §2.4 shows the reuse correction is *not* a simple uplift: because their reuse is all-or-nothing, expected computed prefill is dominated by (1−h) × full prompt, and NInfer needs **h ≥ 0.87** to match vLLM's measured 9,726 computed tokens/request |
| 3 | Their docs disagree: makespan C=4/2.83×/58% vs. README C=8/5.33×/46% | **Both carried, and both ruled inapplicable** — §3 shows C=8 delivers 1 concurrent pi turn and C=4 delivers 2, so neither multiplier is reachable; §6 shows closed-loop makespan does not describe 0.82-occupancy interactive traffic |
| 4 | Acceptance is 37–91% by category | §7.2. Anchored on our own **measured 67.9%** on this exact traffic, then discounted to **55–72%** for their systematically lower Qwen3.8 numbers |
| 5 | Their INT8 KV vs. our fp8 | **Determinable for capacity, not for speed.** fp8 E4M3 row-256 is **2.3% smaller** per token than INT8 group-64 (128 scales vs. 512), so their pool figures are if anything mildly pessimistic for us. Throughput and quality direction: **not determinable** — no NInfer benchmark varies KV dtype |
| 6 | Corpus makespan is a batch benchmark | §6. Quantified: our time-averaged occupancy is **0.82 requests**. Makespan speedups measured at pinned occupancy C do not transfer; the interactive gain is bounded by the per-stream improvement |

Also carried: their box is **32 GiB**, ours is **31 GiB** (`nixos.nix:125`) — worth ~12,000
tokens of pool at C=4, included in §3.2.

---

## 9. What would make this projection wrong

Ordered by how much damage each does.

1. **The prefix-reuse hit rate is bimodal and I cannot resolve which mode we land in.** If pi's
   assistant-message re-render does not reproduce the model's emitted tokens *and* the
   `turn_closure` fallback also misses, h collapses to ~10% and every prefill and TTFT number in
   §0 is wrong by 3–5×. R1 found the fix for exactly this path (`a140e7ae`) landed the day of
   this study — so it was broken until 2026-09-03, and there is no evidence it is now right for
   *pi's* renderer specifically. **This is the number to measure first.**
2. **The 1.21× MTP3 round cost may not survive a real deployment** (§7.3). It is fitted to their
   fixtures; the vLLM 1.62× it is compared against comes from a different soak. If NInfer's real
   round cost is 1.5×, MTP3 decode drops from 135–180 to ~110–145 tok/s.
3. **The back-solved 1.95 GiB workspace constant** (§3.1) carries the whole C-sweep. If NInfer's
   workspace scales with C (I assumed it does not, beyond graphs and replay records), every pool
   figure is optimistic and the C=8 verdict gets *worse*, not better. If it is smaller than I
   think, C=8 might reach 2 concurrent turns — still not 8.
4. **`--kv-dtype nvfp4` is two days old and nobody has benchmarked it.** It is the only lever
   that materially moves concurrency (2 → 4 turns at C=4). If it costs quality on a
   64k-context agentic workload, the concurrency story reverts to "same as vLLM."
5. **I assumed pi keeps sending `max_tokens ≈ 30,032`.** The 94,208-token reservation is derived
   from `settings.nix:40` and pi's clamp. If pi's clamp logic changed, or if a future pi sends a
   small `max_tokens`, NInfer's concurrency improves materially and vLLM's does not.
6. **Their published rates are single-request on an idle box.** Our vLLM 5,378.8 tok/s prefill
   and 51–53 tok/s decode are production averages under 0.82 mean occupancy with chunked prefill
   fused in. The comparison is generous to NInfer in both directions and I have not corrected for
   it beyond widening ranges.
7. **v0.28.1 + MTP may just work** (§7.4, R2 §6). That is not a flaw in this projection, it is
   the alternative that makes it moot.
8. **Nothing here was built or run.** No NInfer binary exists on any machine we own; there is no
   `.ninfer` artifact for our weights; nobody has ever run this engine on our traffic.

## 10. What is *not* determinable without a bench

Stated explicitly rather than estimated:

- **fp8 vs. INT8 KV effect on decode/prefill throughput and on output quality.** No NInfer
  benchmark varies KV dtype. Capacity direction is determinable (§8 row 5); speed is not.
- **NVFP4 KV quality at 64k context.** Added 2026-09-01, zero published measurements.
- **The `--prefill-chunk` trade curve** (§4.2). Their 5,297.9 tok/s is a single point at chunk
  1024.
- **Real TTFT p95/p99 under our burst pattern.** Every published NInfer latency number is
  single-request or 293-token-prompt saturation. The interaction of single-lane prefill, 94,208-
  token reservations, no preemption and 16-deep fan-out has no published analogue.
- **Whether host→device checkpoint restore actually costs 60–120 ms.** That is my PCIe
  arithmetic (§2.3), not their measurement. They ship a `tools/bench/ttft/` harness that covers
  "hot reuse, Host resume, eviction, shared prefixes" but publish no numbers from it.
- **Redtruck's host RAM**, which caps the one lever (§2.3) that could push h into the tuned
  range. Not in this repo.

## 11. The three measurements that would collapse most of this uncertainty

For whoever writes the bench recipe (V1):

1. **Hit rate, first and cheapest.** Run NInfer with `--request-log-jsonl` against a replayed pi
   session and read `prefix_reuse_path` + `prefix_cache_hit_tokens` per request (R1 §6). No
   throughput measurement needed — just the distribution of `root` / `private_endpoint` /
   `private_turn_closure` over 200 real turns. This single number decides items 1 and 2 of §9
   and picks between the 25–55% and 70–90% branches of §2.4.
2. **The C-sweep against reality.** Start at `--max-concurrency 2, 4, 8` with
   `--max-context 102400` and read back `Engine::options()`'s resolved `kv_capacity`, then watch
   `throughput.running` / `waiting` under a 4-request burst of 64k turns. Confirms or refutes
   §3.2 in ten minutes and needs no client-side timing.
3. **The non-overlap tax.** One 64k cold request issued while one stream is decoding; read
   `engine_timing.device_wait_exposed_seconds` on the decoding request. Directly measures §4.1's
   7–9% duty cycle.

All three run off the same build and the same artifact, and none of them requires a
statistically clean A/B — they are structural checks, and each one can falsify a load-bearing
claim above on its own.
