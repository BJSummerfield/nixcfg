# Change / Keep — the list

Ranked by measured value against cost. Evidence for every claim is in
`01-measurements.md`; reasoning in `02-vllm-and-model.md`, `03-ninfer.md` and
`06-llama-swap-removal.md`.

The framing that reorders everything: **this workload is 56:1 input:output, but 78% of
input tokens are already served from prefix cache, so prefill is nearly free. Decode is
68.6% of latency, queueing is 14.8%, prefill is 16.0%.** Context-window and KV-pool
tuning — which is what almost every comment in `models.nix` is about — is close to
performance-neutral. Concurrency and output tokens are the levers.

---

## CHANGE

### C1. Bump `vllmImage` v0.26.0 → v0.28.0 — correctness, do this first
`modules/local-llm/nixos.nix`

Running config is Qwen3.x hybrid + `--enable-prefix-caching` + `--mamba-cache-mode align`
+ MTP. That is the exact combination in vLLM issue #47194 and PR #47861: *"tool-call
leakage, recall failures, and degenerate generations on cache-hit paths."* Observed
symptom rate here: **120 malformed tool calls in 14.3 h**, 46 with completely empty
arguments, 27 with an array parameter delivered as a JSON string.

**Verified 2026-09-01** (`02-vllm-and-model.md` §3 has the full table):
- PR #51113 merged 2026-08-06 (`c56f169d9ae4`); **v0.28.0 is the first tag containing it**
  — confirmed by `compare v0.28.0...c56f169d9ae4 -> behind, ahead=0`. It is *not* in
  v0.27.0 or v0.27.1 despite merging before them, so there is no cheaper hop.
- #51113 closed **#43559** (the 20% accuracy drop) one second after merging.
- **#47194 (tool-call leakage) is still OPEN.**

So this is a well-founded change against a confirmed bug in the same code path, but it is
**an experiment for our tool-call symptom, not a guaranteed fix**. Capture the baseline
first so the result is readable:

```bash
B=https://llm.mist-gamma.ts.net:8443
curl -s $B/upstream/Qwen3.8-27B-NVFP4/metrics > baseline-metrics.txt   # before
# after switch + a day of normal use, diff these:
#   vllm:request_success_total{finished_reason="length"} / _total requests
#   malformed tool calls: rg -c 'Validation failed for tool' over new sessions
```

Rollback is one string. `vllm-image-pull` is `Type=exec`, so the download does not block
the switch, and `--pull=never` fails fast rather than downloading inside a health window.

### C2. `maxNumSeqs` 2 → 4
`modules/local-llm/models.nix`

Measured knee is exactly at the third in-flight request — the first one that has to queue:

```
1 in flight:  9.7 s per 1k output tokens
2 in flight:  9.8 s   (batching the 2nd lane is FREE)
3 in flight: 12.4 s   (+27%)
4 in flight: 18.4 s   (+89%)
≥6:          34.9 s   (+260%, tail reaches 16 in flight and 480 s of pure queue wait)
```

**55.0% of requests arrive with ≥3 already in flight.** The `maxNumSeqs = 2` rationale
cites `run-history.jsonl` showing "~441 s of genuine 2-wide" — that dataset predates the
pi-subagents fan-out and no longer describes the traffic.

The memory objection does not survive contact with the metrics:
- The pool is **197,283 tokens**, not the "~170k" the comments interpolate.
- `2 × 68k = 136k` assumes zero block sharing; **78% of prompt tokens are cache hits**, so
  lanes share blocks and cost far less than the arithmetic says.
- `num_preemptions_total = 3,181` over `3,201` requests — **preemption is already running
  at ~1 per request at `maxNumSeqs = 2`.** The low cap is not buying preemption-freedom;
  it is buying queue time on top of preemption you are paying anyway.

NInfer's published sweet spot for this exact model is C=4. Watch `num_preemptions_total`
and the `request_queue_time_seconds` histogram after the change.

### C3. `maxModelLen` 131072 → 102400, `headroom` 32768 → 4096
`modules/local-llm/models.nix` — **`contextWindow` stays exactly 98,304; no pi behaviour changes**

pi's `clampMaxTokensToContext` guarantees `input + max_tokens ≤ contextWindow − 4096 =
94,208`. It is structurally impossible for pi to send more. But vLLM is told
`--max-model-len 131072`, and derives:

```
kv_cache_max_concurrency = 197,283 / 131,072 = 1.505
```

vLLM is sizing itself for **1.5 concurrent sequences — below the 2 you asked for**.
At 102,400 that becomes 1.93, and it pairs directly with C2.

Because `contextWindow = maxModelLen − headroom`, both numbers must move together to keep
pi unchanged: `102,400 − 4,096 = 98,304`, same as today. That leaves 8,192 tokens of slack
between pi's hard maximum (94,208) and vLLM's ceiling (102,400) — twice the drift margin
`headroom` was actually providing, since 4,096 of it already lives inside pi.

**This trades window for lanes and the two directions conflict.** The alternative is
`headroom = 4096` at the current `maxModelLen = 131072` → `contextWindow = 126,976`, giving
agents ~110k of usable history instead of ~65k but pushing `kv_cache_max_concurrency` down
to 1.55. Take the lanes: concurrency is the measured bottleneck, history is not.

### C4. Set `settings.compaction.reserveTokens = 32768` in pi
`modules/pi-coding-agent/settings.nix` — currently unset, so it defaults to 16384

24 of 1,287 turns (1.9%) ended `stopReason: "length"`, **15 of them emitting exactly one
token**. Each burns a ~94k-token prefill to produce one token, then triggers a compaction
and a retry.

Mechanism, from pi's source:
- compaction fires at `contextWindow − reserveTokens = 81,920`
- pi clamps output to 1 at `contextWindow − 4096 = 94,208`
- the unguarded band is `reserveTokens − 4096 = 12,288` tokens wide

Any single tool result over ~12k tokens jumps the band in one step. Subagent reports and
file reads routinely do.

**`headroom` does not affect this at all** — the band depends only on `reserveTokens`,
which nothing in this repo currently sets. That is worth correcting in the `models.nix`
comment even if the value is left alone.

Cost: compaction fires at 65,536 instead of 81,920, so ~20% earlier and more often
(47 compactions in this run). Measure `finished_reason="length"` on
`/upstream/<model>/metrics` before and after — it was 124/3,201 (3.9%).

### C5. Persist vLLM's stdout
`modules/local-llm/llama-swap.nix` — add `--log-driver=journald --log-opt tag=vllm-<name>`
to the `podman run` line

Today `--rm` means the container's log dies with it. The startup lines that every tuning
comment in `models.nix` instructs the reader to consult — "GPU KV cache size", "Setting
attention block size to N tokens", the `max_num_scheduled_tokens` advisory — do not
survive a restart and are not correlatable with agent sessions after the fact.

### C6. Scrape `/upstream/Qwen3.8-27B-NVFP4/metrics`
new, small

This endpoint answered in one scrape three things `models.nix` has been guessing at:
pool size, preemption rate, prefix-cache hit rate. A 60-second cron'd curl into a file is
enough to turn future tuning arguments into diffs. Implemented in this PR; see
`06-llama-swap-removal.md` for where the endpoint moved to.

### C7. After C1 lands, A/B `speculativeTokens` 3 → 4
`modules/local-llm/models.nix`

Per-position MTP acceptance: pos0 80.7%, pos1 66.6%, **pos2 56.4%** — position 2 is not
exhausted, so a 4th draft token plausibly lands around 45–50% and still pays. Overall
acceptance is 67.9% at 3.04 tokens emitted per decode step.

Do this **after** the image bump, not before — MTP is half of the correctness bug in C1,
so tuning it on the old image measures the wrong thing.

### C8. Correct the stale numbers in `models.nix`
- KV pool is **197,283 tokens**, not "~170k interpolated". Read
  `vllm:cache_config_info{kv_cache_size_tokens}` rather than the startup line.
- The `maxNumSeqs = 2` rationale cites a dataset that no longer describes the workload.
- `headroom` is documented as protecting the compaction band. It does not; `reserveTokens`
  does.
- The pool/window arithmetic assumes no block sharing while prefix caching delivers 78%.

### C9. Untested but probably the largest wall-clock lever: `defaultThinkingLevel`
`modules/pi-coding-agent/settings.nix` — currently `"high"` → `xhigh`

Decode is 68.6% of latency and output tokens are the only thing that costs time. Every
turn currently defaults to the most expensive effort the template accepts, and
`subagents.maxThinking = "xhigh"` lets children do the same.

I have no measurement splitting output tokens by effort level, so this is a flagged lever,
not a recommendation. `medium` is already the established floor (`low` is ruled out on
quality). Worth an explicit A/B: `defaultThinkingLevel = "medium"` with escalation to
`high`/`xhigh` per dispatch, measured on `vllm:generation_tokens_total` per unit of work.

---

## KEEP

### ~~K1. llama-swap~~ — REVERSED, now a change: remove it
This entry argued "keep", because `/upstream/<model>/metrics` is the sole route to vLLM's
Prometheus data. Circular: it is the sole route *because* llama-swap assigns the vLLM port
dynamically. A fixed port makes `/metrics` directly scrapeable with no proxy, and removal
additionally drops the bind-mounted root-equivalent podman socket that the module's own
comments warn about three times.

Still true, and the real cost of removal: `/api/metrics/activity` is a per-request
token+duration history vLLM has no equivalent for. Not enough to justify the socket grant.

Plan: [`06-llama-swap-removal.md`](06-llama-swap-removal.md). Sequenced after the
concurrency change (C2/C3).

### K2. vLLM as the engine, for now
Both things NInfer would buy — concurrency scaling and per-request observability — are
available on the current engine for near-zero cost (C2, C6). Spend those first. See
`03-ninfer.md` for the bench plan that would revisit this honestly.

### K3. `--enable-prefix-caching` + `--mamba-cache-mode align`
78% of prompt tokens served from cache; it is the single reason prefill is nearly free and
the reason context size stopped mattering. `models.nix` says the A/B on the incoherence
signature is "this flag first". **Do not do that.** The upstream bug is in the
MTP × prefix-cache *interaction* and was fixed on the scheduler side; bump the image
(C1) and re-measure the malformed-tool-call rate before touching a flag that is buying
you this much.

### K4. MTP speculative decoding
67.9% acceptance, 3.04 tokens per decode step. Working well — better acceptance than
NInfer publishes for the same model. Tune it (C7), do not remove it.

### K5. `kvCacheDtype = "fp8"`, `maxNumBatchedTokens = 4096`
4096 clears the `block_size (1600) ≤ max_num_batched_tokens` assert that `align` requires
and keeps the MTP scheduler off the `vllm.py:1718` advisory. It also is not the pool
constraint the comments treat it as. Leave both.

### K6. One model, no alias, no `subagents.defaultModel`
PR #148 is validated by the data: 27 hard 400s and two dead reviewer runs before, zero
after, across 14.3 h and 3,201 requests. The reasoning in the deleted-alias comment is
correct and worth keeping verbatim.

### K7. `maxTokens = 32768`
The `-44k` alias's 8192 demonstrably truncated xhigh review verdicts at
`stopReason: "length"`. Do not reintroduce a smaller output budget as a pool guard.

### K8. Thinking-effort routing via `chat_template_kwargs`, `supportsThinkingTokenBudget = false`
vllm#44676 is real and the workaround is sound. (Note for any NInfer migration: NInfer
rejects unknown `chat_template_kwargs` and wants top-level `reasoning_effort` instead.)

### K9. Weights as a nix `linkFarm` of pinned `fetchurl` blobs, engine as a pinned OCI image
The split is right: nix owns the reproducible artifact, the container owns the CUDA stack
that nix builds badly. Keep it if you ever evaluate NInfer — which has no OCI image and
would need real nix packaging.

### K10. The parked Qwen3.6 catalog entry
Out of `enabled`, hashes and tuning retained. Exactly the right shape for the C1 rollback
and for any engine A/B.

---

## DON'T

- **Don't chase `cacheRead: 0` *in pi or in nix*** — pi maps the field correctly
  (`openai-completions.js:1108`) and llama-swap reports `cache_tokens: -1` downstream of
  the same gap. But this is a **server-side bug that may already be fixed**: vLLM #44961
  was closed as completed 2026-07-14 ("confirmed working in 0.23–0.25.1"), while a direct
  probe of our v0.26.0 returns `"prompt_tokens_details": null`. Re-probe after C1 — it may
  come free with the bump. Until then `vllm:prompt_tokens_cached_total` is the only view.
- **Don't remove llama-swap in the same change as the engine bump or the concurrency
  tuning** — not because it is the rollback path (it is not; `git revert` is), but because
  bundling an architecture change into a correctness experiment makes the result
  unreadable. Removal is queued after C2/C3: [`07`](06-llama-swap-removal.md).
- **Don't migrate to NInfer yet** — but do build the one-day bench in `03-ninfer.md`.
- **Don't tune the KV pool for speed.** It is not what is costing time.
