# Baseline — running vLLM stack, 2026-09-03

Agent S1. Mechanical capture and arithmetic only — no architectural judgement. Every
number below gives the command/formula that produced it. Anything I could not get is
marked **not determinable** rather than estimated.

## 0. Capture

```
date -u +"%Y-%m-%dT%H:%M:%SZ"   # before
curl -s https://llm.mist-gamma.ts.net:8443/metrics > docs/ninfer-vs-vllm-2026-09-03/data-vllm-2026-09-03.prom
date -u +"%Y-%m-%dT%H:%M:%SZ"   # after
```

**Capture time: 2026-09-03T18:56:16Z** (both timestamps agreed to the second — the
scrape is instantaneous). Raw file: `docs/ninfer-vs-vllm-2026-09-03/data-vllm-2026-09-03.prom`
(645 lines). Endpoint reached directly, no proxy, confirming the plan's premise that
llama-swap is gone (`0fea091`).

`process_start_time_seconds = 1788412312.64` → engine started **2026-09-03 05:11:52 UTC**.
Uptime at capture: **49,463 s = 13.74 h**. All counters below are cumulative since that
start (`date -u -d @1788412312`).

## 1. Request counts and histogram means

Command for all of these: read `_sum{...}` and `_count{...}` for the named
`vllm:request_*` / `vllm:e2e_*` / `vllm:time_to_first_token_seconds` series from the
`.prom` file, mean = sum/count.

```
grep -E "^vllm:(request_queue_time_seconds|request_prefill_time_seconds|request_decode_time_seconds|e2e_request_latency_seconds|time_to_first_token_seconds|request_time_per_output_token_seconds|inter_token_latency_seconds|request_inference_time_seconds)_(sum|count)\{" data-vllm-2026-09-03.prom
```

Requests completed (`vllm:request_success_total`, summed over `finished_reason`):
**1,578** (1,576 `stop` + 2 `length` + 0 abort/error/repetition).

| phase | sum (s) | count | mean (s) | share of e2e |
| --- | ---: | ---: | ---: | ---: |
| queue | 2,214.259 | 1,578 | **1.403** | 5.2% |
| prefill | 2,853.420 | 1,578 | **1.808** | 6.7% |
| decode | 37,519.711 | 1,578 | **23.777** | 87.8% |
| e2e | 42,726.545 | 1,578 | **27.076** | 100% |
| inference (vLLM's own prefill+decode) | 40,373.131 | 1,578 | 25.585 | — |

Sanity check: queue+prefill+decode = 26.988 s vs. e2e mean 27.076 s (diff 0.088 s/req,
~0.3% — some overhead outside the three phases, not investigated further).

TTFT: `vllm:time_to_first_token_seconds` sum=5,210.326, **count=1,579** (one more than
request count — an in-flight request had emitted its first token but not yet finished
at scrape time). **Mean TTFT = 3.300 s.** Cross-check: queue mean + prefill mean =
3.211 s, close to the 3.300 s TTFT mean (small gap consistent with the extra in-flight
sample).

### TPOT — two different vLLM series, both reported

vLLM exposes TPOT two ways and they are not the same aggregation:

- `vllm:inter_token_latency_seconds` — **per-token** samples, one observation per
  generated token. sum=37,674.817, count=2,012,574. **Mean = 0.01872 s = 18.72 ms**
  (token-weighted).
- `vllm:request_time_per_output_token_seconds` — **per-request** samples, one
  observation per completed request (that request's own mean TPOT). sum=30.848,
  count=1,578. **Mean = 0.01955 s = 19.55 ms** (request-weighted).

Both imply per-stream decode throughput of **53.4 tok/s** (from ITL) or **51.2 tok/s**
(from request-TPOT) — call it **~52 tok/s per stream**.

## 2. Bucket distributions — queue time and TTFT shape

```
grep -E "^vllm:request_queue_time_seconds_bucket\{" data-vllm-2026-09-03.prom
grep -E "^vllm:time_to_first_token_seconds_bucket\{" data-vllm-2026-09-03.prom
```

**Queue time** (n=1,578, cumulative %):

| le (s) | cum % |
| --- | ---: |
| 0.3 | 93.1% |
| 2.0 | 93.5% |
| 5.0 | 94.0% |
| 10 | 94.7% |
| 15 | 96.2% |
| 20 | 97.7% |
| 30 | 98.9% |
| 60 | 99.7% |
| 120 | 100% |

Shape: dominant mass at near-zero queue (93.1% under 0.3 s), then a long right tail out
to somewhere between 60 s and 120 s (the last bucket boundary the histogram actually
crossed). There is a mild secondary cluster in the 10–30 s range (+3.4 pp of mass there)
but nothing that reads as a sharp second mode — **not clearly bimodal**, more a single
fast peak with a long tail.

**TTFT** (n=1,579, cumulative %):

| le (s) | cum % |
| --- | ---: |
| 0.1 | 0.1% |
| 0.25 | 13.0% |
| 0.5 | 52.1% |
| 0.75 | 69.7% |
| 1.0 | 74.5% |
| 2.5 | 82.5% |
| 5.0 | 86.8% |
| 10 | 91.4% |
| 20 | 95.1% |
| 40 | 98.7% |
| 80 | 99.8% |
| 160 | 100% |

Shape: one dominant fast mode (39 pp of all mass lands between 0.25 s and 0.5 s alone —
consistent with prefix-cache-hit prefill being nearly instant), 74.5% of all requests
under 1 s, then a long decaying tail out to 160 s for cold/queued requests. **Also not
cleanly bimodal** — a single fast peak plus a heavy right tail, not two separated humps.

## 3. Decode throughput — aggregate and per-stream

Multiple defensible formulas exist; all are given so a later agent can pick the one
comparable to whatever NInfer number it's matched against.

- **Per-stream, from TPOT:** 1/0.01872 = **53.4 tok/s** (ITV-based) or 1/0.01955 =
  **51.2 tok/s** (request-TPOT-based). This is what a single decoding stream sustains.
- **Token-weighted aggregate** (`generation_tokens_sum / request_decode_time_seconds_sum`
  = 2,004,034 / 37,519.711): **53.41 tok/s**. This is the formula that reproduces the
  09-01 doc's "Aggregate decode 97.9 tok/s" headline (inferred by matching its value
  against the 09-01 mean-TPOT-implied per-stream rate of ~100 tok/s, which it tracks
  closely) — **note this label is inferred, not confirmed from the 09-01 source's own
  method statement**, since that doc doesn't show its arithmetic for that line. It is
  a token-weighted per-stream rate, not true wall-clock system throughput, because
  `request_decode_time_seconds_sum` overlaps when requests decode concurrently.
- **True system wall-clock throughput, incl. idle time**
  (`generation_tokens_total counter / uptime` = 2,014,153 / 49,463.36): **40.72 tok/s**.
  This is the only formula that accounts for the fact the engine was often idle
  (`num_requests_running` was 1 at the point-in-time scrape below) — it is depressed by
  idle gaps between requests, not by decode speed itself.

Point-in-time scrape at capture: `num_requests_running=1`, `num_requests_waiting=0` —
the engine was not saturated at the moment of the scrape. **Effective concurrency is
close to serialized at this workload**, given `kv_cache_max_concurrency ≈ 2.07` and
`maxNumSeqs=3`; do not read the ~53 tok/s "aggregate" figure as evidence of batched
throughput — it's essentially single-stream.

## 4. Prefill: compute rate vs. effective rate

```
grep -E "^vllm:request_prefill_kv_computed_tokens_(sum|count)\{|^vllm:request_prompt_tokens_(sum|count)\{|^vllm:request_prefill_time_seconds_(sum|count)\{" data-vllm-2026-09-03.prom
```

- computed prompt tokens (`request_prefill_kv_computed_tokens_sum`): **15,347,999**
- total prompt tokens (`request_prompt_tokens_sum`): **86,419,167**
- prefill time (`request_prefill_time_seconds_sum`): **2,853.420 s**

**Compute rate** = 15,347,999 / 2,853.420 = **5,378.8 tok/s** — what the GPU actually
crunches through.

**Effective rate** = 86,419,167 / 2,853.420 = **30,286.2 tok/s** — what a client
experiences per second of prefill wall-time, including the tokens served from cache
for free. The gap (5.6x) is what prefix caching buys on this workload.

(A near-duplicate counter, `vllm:prompt_tokens_by_source_total{source="local_compute"}`
= 15,376,417, gives an almost-identical compute rate of 5,388.8 tok/s — the two
"computed tokens" counters disagree by 0.2%, not investigated further, both reported.)

## 5. Prefix cache hit rate

```
grep -E "^vllm:prompt_tokens_by_source_total\{" data-vllm-2026-09-03.prom
```

```
vllm:prompt_tokens_by_source_total{source="local_cache_hit"}  71,071,168
vllm:prompt_tokens_by_source_total{source="local_compute"}    15,376,417
vllm:prompt_tokens_by_source_total{source="external_kv_transfer"}   0
```

Hit rate = 71,071,168 / (71,071,168 + 15,376,417) = **82.2%**. Cross-checked two other
ways and all three agree to within 0.05 pp:
`prompt_tokens_cached_total / prompt_tokens_total` = 82.21%;
`prefix_cache_hits_total / prefix_cache_queries_total` (token-level lookups, not
prompt-level) = 82.17%.

## 6. Preemptions per request

```
grep -E "^vllm:num_preemptions_total\{" data-vllm-2026-09-03.prom
```

`vllm:num_preemptions_total = 197`. Over 1,578 completed requests: **0.125
preemptions/request = 12.5%**.

## 7. KV pool

```
grep -E "^vllm:cache_config_info\{" data-vllm-2026-09-03.prom
```

| field | value |
| --- | --- |
| `kv_cache_size_tokens` | **211,911** |
| `kv_cache_max_concurrency` | **2.069** |
| `num_gpu_blocks` | 149 |
| `block_size` | **1568** |
| `mamba_block_size` | **16** |
| `mamba_cache_mode` | **align** |
| `mamba_cache_dtype` | auto |
| `mamba_ssm_cache_dtype` | float32 |
| `cache_dtype` | **fp8** |
| `enable_prefix_caching` | True |
| `gpu_memory_utilization` | 0.95 |
| `prefix_caching_hash_algo` | sha256 |

Check: `kv_cache_size_tokens / kv_cache_max_concurrency` = 211,911 / 2.0694 ≈ 102,400 =
exactly `maxModelLen` from `models.nix`, confirming the concurrency figure's own
definition (pool tokens ÷ max sequence length).

## 8. Speculative decoding (MTP) status

```
grep -c "spec_decode" data-vllm-2026-09-03.prom
```

**Result: 0 matches — zero `vllm:spec_decode_*` series of any kind exist in the
scrape.** Confirms MTP is fully off in the running engine, consistent with
`models.nix` (`# No speculativeTokens: MTP is off`) and `nixos.nix`'s comment on the
v0.28.0 image pin.

## 9. Scheduler state (point-in-time only)

```
grep -E "^vllm:(num_requests_running|num_requests_waiting|num_requests_waiting_by_reason|kv_cache_usage_perc)\{" data-vllm-2026-09-03.prom
```

```
num_requests_running                    1
num_requests_waiting                    0
num_requests_waiting_by_reason(capacity) 0
num_requests_waiting_by_reason(deferred) 0
kv_cache_usage_perc                     0.3514
```

This is a single sample at 18:56:16Z, not an aggregate — the engine was not under load
at the instant of the scrape. It says nothing about behavior under the queueing
episodes visible in the queue-time and TTFT tails above.

## 10. Config context

### `modules/local-llm/models.nix` — Qwen3.8-27B-NVFP4 entry (relevant fields)

```
maxModelLen        = 102400
headroom           = 4096
maxTokens          = 32768
sampling.temperature = 1.0, top_p = 0.95, top_k = 20, min_p = 0.0
vllm.gpuMemoryUtilization = 0.95
vllm.maxNumSeqs           = 3
vllm.maxNumBatchedTokens  = 4096
vllm.kvCacheDtype         = "fp8"
vllm.toolCallParser       = "qwen3_xml"
vllm.reasoningParser      = "qwen3"
vllm.enablePrefixCaching  = true
# no speculativeTokens key — MTP off
vision.maxImages = 8, width = 1280, height = 800
enabled = [ "Qwen3.8-27B-NVFP4" ]   (Qwen3.6 entries parked, out of `enabled`)
```

### `modules/local-llm/nixos.nix` — image pin and comments

`vllmImage = "docker.io/vllm/vllm-openai:v0.28.0"`. Comment block: v0.28.0 was taken
for upstream PR #51113 ("keep mamba align prefill chunks block-aligned past
last_cache_position"), the first tag containing half the correctness fix for hybrid
Mamba prefix-caching + MTP; it was **not enough** — corruption continued (mojibake,
leaked tool-call XML) — so MTP was turned off in `models.nix` rather than waiting for
the rest of the upstream fix (vllm#47194, plus CUDA/off-by-one issues split from
vllm#43559, both still open per that comment). v0.28.0 also defaults prefix caching on
for Mamba models (#50991); the explicit `--enable-prefix-caching` flag is kept anyway
for documentation/future-proofing. The re-enable gate for MTP is stated as "a tag that
closes those issues, then A/B it over a long agentic session."

### `modules/local-llm/vllm-service.nix` — reconstructed effective command line

Built from `vllmArgs` in that file plus the values above (`servedNames` = just
`Qwen3.8-27B-NVFP4`, no aliases currently defined for this model):

```
podman run --rm --replace --pull=never \
  --name vllm-qwen3.8-27b-nvfp4 \
  --log-driver=none \
  --device nvidia.com/gpu=all \
  --ipc=host \
  -e HF_HUB_OFFLINE=1 \
  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  -p 192.168.100.24:5800:8000 \
  -v <weights-store-path>:/model:ro \
  -v /nix/store:/nix/store:ro \
  -v /var/lib/local-llm/vllm-cache:/root/.cache \
  docker.io/vllm/vllm-openai:v0.28.0 \
  --model /model \
  --served-model-name Qwen3.8-27B-NVFP4 \
  --kv-cache-dtype fp8 \
  --max-model-len 102400 \
  --gpu-memory-utilization 0.95 \
  --limit-mm-per-prompt '{"image": {"count": 8, "width": 1280, "height": 800}, "video": 0}' \
  --max-num-batched-tokens 4096 \
  --max-num-seqs 3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3 \
  --override-generation-config '{"temperature": 1.0}' \
  --enable-prefix-caching \
  --mamba-cache-mode align
```

`hostAddress`/`port` interpolate to `192.168.100.24:5800` per the comments in
`nixos.nix` (§ "8443 target is the HOST... 8080 -> Open WebUI, 8443 -> vLLM"); the
weights path is a nix-store symlink target resolved by `weightsOf`, not reproduced
literally here since it wasn't evaluated.

## 11. Per-request source — none found

Checked, in order:

1. **llama-swap `/api/metrics/activity`** — confirmed gone; llama-swap itself was
   removed in `0fea091` ("serve vLLM from a systemd unit, drop llama-swap"). No
   replacement endpoint exists anywhere under `modules/local-llm/` —
   `grep -rn "activity\|request.log\|per-request\|requestLog" modules/local-llm/`
   returns nothing.
2. **`~/.pi/agent/run-history.jsonl`** — has a `duration` field, but (a) it is the
   duration of an entire subagent *run* (many LLM turns + tool calls), not a single
   LLM request, and (b) the file's last write is **2026-09-02 17:36:38 -0500 =
   2026-09-02 22:36:38 UTC**, which is *before* the engine restart at
   2026-09-03 05:11:52 UTC. It cannot describe the population the histograms above are
   drawn from.
3. **`~/.pi/agent/sessions/*/*.jsonl`** — active sessions postdating the restart exist
   (e.g. `--var-lib-paseo-worktrees-1dmwkbm2-clean-toad--`, last write 2026-09-03
   13:43 local / recent UTC) and do carry per-message token `usage` (input/output/
   cacheRead/reasoning) against `model:"Qwen3.8-27B-NVFP4"`. But there is **no explicit
   per-request duration field** in these records — the only timing field present,
   `elapsedMs`, belongs to a different event type (`"reason":"idle"`, a subagent
   idle-watchdog message, not request latency). Reconstructing a duration would require
   pairing consecutive message timestamps per conversation, which is contaminated by
   tool-call time, thinking time, and concurrent subagent traffic sharing the same
   engine — exactly the ambiguity the 09-01 doc's llama-swap-timestamp discovery had to
   correct for, and there is no equivalent server-side ground truth here to correct
   against.

**Conclusion: no usable per-request source exists post-#156 restart.** The
`duration ~ a*input + b*output + c` fit from `01-measurements.md` (09-01) cannot be
re-run. This is stated plainly per the task instructions rather than fabricated from
session-timestamp deltas.

## 12. Diff against `docs/local-llm-review-2026-09-01/01-measurements.md`

**Caveat, stated up front:** the 09-01 numbers are a 3,201-request population from a
different engine start (unknown uptime, different `maxNumSeqs`, different workload mix
— it included the 14.3 h orchestrator run explicitly). The 09-03 numbers are a
1,578-request population from the current 13.74 h uptime. These are **not** two
samples of the same population — differences below are consistent with the MTP removal
but are not a controlled A/B. Treat every row as "what changed between two production
soaks under different config and different traffic," not as an isolated causal
measurement of MTP alone.

| metric | 09-01 (pre-MTP-removal, N=3,201) | 09-03 (post-#156, N=1,578) | delta |
| --- | ---: | ---: | ---: |
| queue mean | 3.04 s | 1.403 s | −54% |
| prefill mean | 3.29 s | 1.808 s | −45% |
| decode mean | 14.05 s | 23.777 s | **+69%** |
| e2e mean | 20.49 s | 27.076 s | +32% |
| TTFT mean | 6.50 s | 3.300 s | −49% |
| **TPOT mean** | **9.98 ms** | **18.72 ms (ITL) / 19.55 ms (req)** | **+88% to +96%** |
| per-stream decode tok/s | ~100.2 tok/s | ~53.4 / 51.2 tok/s | **≈ −48%, roughly halved** |
| "aggregate" decode tok/s (token-weighted, same formula family) | 97.9 tok/s | 53.41 tok/s | −45% |
| prefill compute rate | 4,042 tok/s | 5,378.8 tok/s | +33% |
| prefill effective rate | 18,387 tok/s | 30,286.2 tok/s | +65% |
| prefix cache hit rate | 78.0% | 82.2% | +4.2 pp |
| preemptions per request | 3,181/3,201 = **99.4%** | 197/1,578 = **12.5%** | **−86.9 pp** |
| `kv_cache_size_tokens` | 197,283 | 211,911 | +7.4% |
| `kv_cache_max_concurrency` | 1.505 | 2.069 | +37% |
| `num_gpu_blocks` | 146 | 149 | +2% |
| `block_size` | 1600 | 1568 | −2% |
| `maxNumSeqs` (config) | 2 | 3 | +1 |
| spec_decode metrics | present, 67.9% overall acceptance | **absent (0 series)** | MTP fully removed |
| request_success_total | 3,201 | 1,578 | (different sample size) |

**TPOT hypothesis: confirmed.** The working hypothesis was that removing MTP roughly
doubled TPOT. Measured: 9.98 ms → 18.72–19.55 ms, an **88–96% increase — consistent
with "roughly doubled."** Per-stream decode throughput fell in lockstep, from ~100
tok/s to ~51–53 tok/s (also roughly halved), which is the same fact stated the other
way: with MTP's ~3.0 tokens/step gone, the engine is back to committing one token per
decode step, so wall-clock per output token roughly doubles.

**Second-order finding not part of the original hypothesis:** preemptions per request
fell from 99.4% to 12.5%, and `kv_cache_max_concurrency` rose from 1.505 to 2.069
alongside `maxNumSeqs` going from 2 to 3 and the pool growing 7.4%. Queue and TTFT
means both fell substantially (−54%, −49%) even though decode got much slower. These
config/pool changes and the MTP removal happened together in the commits between the
two captures, so **this diff cannot separate "MTP removal made decode slower" from
"the maxNumSeqs/pool change made queueing better"** — both are visible in the same
table and both are real, but attributing the queue/TTFT improvement specifically to
one cause is **not determinable** from this data alone.
