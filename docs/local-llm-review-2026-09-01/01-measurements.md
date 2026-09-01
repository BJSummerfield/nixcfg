# Measurements — local LLM stack, 2026-09-01

All numbers here are measured, not estimated. Sources and commands are given so
another task can re-run them. Where something is a single point-in-time sample
rather than an aggregate, it says so.

## Sources

| Source | What it is | How to get it |
| --- | --- | --- |
| `~/.pi/agent/sessions/--var-lib-paseo-worktrees-1w5288zd-famed-donkey--/` | Live 14.3 h orchestrator run (2026-08-31 19:23 → 2026-09-01 09:43 local), sort-viz Rust project, pi-subagents fan-out | session `.jsonl` + `subagent-artifacts/*_meta.json` |
| `~/.pi/agent/run-history.jsonl` | 506 subagent runs, 2026-08-09 → 08-31 | jq |
| llama-swap `/api/metrics/activity` | Last 1000 chat-completion requests, server-side: input/output tokens + `duration_ms` | `curl -s "$B/api/metrics/activity?page=N&limit=200"` |
| llama-swap `/upstream/<model>/metrics` | **vLLM's own Prometheus metrics, proxied** | `curl -s "$B/upstream/Qwen3.8-27B-NVFP4/metrics"` |
| pi source | clamp / compaction behaviour | `~/.pi/agent/npm/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js` |

`B=https://llm.mist-gamma.ts.net:8443`. Raw captures saved next to this file as
`data-llamaswap-activity-1000req.tsv` and `data-vllm-metrics-snapshot.txt`.

**Key discovery about the timestamps:** llama-swap's activity `timestamp` is the
request *completion* time, not the start. Verified by correlation against pi's own
message timestamps — pi turn `15:17:26.241Z, in=73711, out=653` is byte-identical to
llama-swap record `10:17:26-05:00, in=73711, out=653, duration=66577 ms`. Any
concurrency analysis must use `start = timestamp - duration`.

## 1. The workload is overwhelmingly prefill, and prefill is nearly free

One 14.3 h session, orchestrator plus all subagents:

| | input tokens | output tokens | ratio |
| --- | ---: | ---: | ---: |
| Orchestrator (1287 turns) | 90,575,121 | 1,368,230 | 66:1 |
| worker (24 runs, 1556 turns) | 99,857,517 | 1,440,318 | 69:1 |
| researcher (14 runs, 350 turns) | 16,324,933 | 643,559 | 25:1 |
| reviewer (29 runs, 399 turns) | 13,444,508 | 477,906 | 28:1 |
| **total** | **220,202,079** | **3,930,013** | **56:1** |

Mean input per worker turn 64,176 — the figure quoted in `models.nix` is confirmed.

But prefix caching absorbs almost all of it. From vLLM's counters (3,201 requests):

```
prompt_tokens_total          193,667,242
prompt_tokens_cached_total   151,059,200   = 78.0% served from cache
local_compute                 42,608,042   = 22.0% actually prefilled
```

Actual prefill compute rate is 4,042 tok/s (`42,550,539 computed tokens / 10,526.6 s`),
but *effective* prefill is 18,387 tok/s because most of the prompt never gets computed.

Independent confirmation from a least-squares fit over the 193 uncontended requests
(≤2 in flight) in the activity log:

```
duration ≈ 0.000002·input + 0.008942·output + 1.43 s
=> input costs ~2 µs/token (i.e. nothing), output costs ~8.9 ms/token
```

**Conclusion: context size is not a performance lever on this stack. Output tokens are.**
Every tuning comment in `models.nix` is written around KV-pool arithmetic; the pool is
not what is costing time.

## 2. Where the 20.5 s mean request actually goes

vLLM histograms, 3,201 requests:

| phase | sum (s) | mean (s) | share |
| --- | ---: | ---: | ---: |
| queue | 9,729.5 | 3.04 | 14.8% |
| prefill | 10,526.6 | 3.29 | 16.0% |
| decode | 44,972.2 | 14.05 | 68.6% |
| **e2e** | **65,595.1** | **20.49** | 100% |

Mean TTFT 6.50 s (= queue + prefill). Mean TPOT 9.98 ms → ~100 output tok/s per stream.
Aggregate decode 97.9 tok/s.

Queue time is bimodal, not uniformly bad:

```
90.2% of requests queue < 0.3 s
 4.4% queue > 20 s
 1.3% queue > 60 s
 0.3% queue > 120 s   (worst bucket reached: 480 s)
```

e2e tail: 85.8% < 40 s, 9.2% > 60 s, 1.7% > 120 s, 0.5% > 240 s.

## 3. `maxNumSeqs = 2` is the binding constraint, and the knee is exactly at 3

Service cost per 1,000 output tokens, bucketed by how many requests were in flight
(activity log, n=1000, `start = ts − duration`):

| in flight | n | share | mean duration | mean out | **s per 1k output** |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 112 | 11.2% | 11.8 s | 1219 | **9.7** |
| 2 | 338 | 33.8% | 12.9 s | 1315 | **9.8** |
| 3 | 249 | 24.9% | 12.4 s | 993 | **12.4** (+27%) |
| 4 | 87 | 8.7% | 20.2 s | 1097 | **18.4** (+89%) |
| 5 | 54 | 5.4% | 36.2 s | 1862 | **19.4** |
| ≥6 | 160 | 16.0% | 88.9 s | 2552 | **34.9** (+260%) |

1 → 2 concurrent is **free** (9.7 → 9.8). The third request — the first one that has to
queue behind `--max-num-seqs 2` — costs +27%, and it degrades from there. Tail reaches
16 in flight. **55.0% of all requests arrive with ≥3 in flight.**

Point-in-time scrape while writing this:
```
num_requests_running   1
num_requests_waiting   3      (reason="capacity", deferred=0)
kv_cache_usage_perc    0.655
```
Three requests waiting while a third of the KV pool sits idle. (Single sample — the
aggregate queue-time histogram above is the load-bearing evidence.)

## 4. The KV pool is bigger than assumed, and `maxModelLen` is throttling concurrency

From `vllm:cache_config_info`:

```
kv_cache_size_tokens      197,283      (models.nix guesses "~170k" — it is 197k)
num_gpu_blocks            146
block_size                1600
mamba_block_size          16
mamba_cache_mode          align
enable_prefix_caching     True
cache_dtype               fp8
gpu_memory_utilization    0.95
kv_cache_max_concurrency  1.505        <-- 197,283 / 131,072
```

`kv_cache_max_concurrency = 1.5` is vLLM's own statement that the pool holds only 1.5
*max-length* sequences. That number is `kv_cache_size_tokens / max_model_len`, and
`max_model_len` is 131,072 — a length **pi structurally cannot ever send** (see §6).

## 5. MTP speculative decoding is working well and position 2 is not exhausted

```
spec_decode_num_drafts_total          1,450,748   (decode steps)
spec_decode_num_draft_tokens_total    4,352,244   (= 3.00 per step, matches num_speculative_tokens=3)
spec_decode_num_accepted_tokens_total 2,953,889   => 67.9% acceptance
  position 0                          1,170,084   => 80.7%
  position 1                            965,618   => 66.6%
  position 2                            818,187   => 56.4%
mean tokens emitted per step = 3.04
```

67.9% overall beats the 57–61% NInfer reports for this model. **Position 2 still accepts
56.4%**, so a 4th draft token would plausibly land around 45–50% and still pay.

## 6. pi's output clamp, and the 1-token wasted turns

`@earendil-works/pi-ai/dist/api/simple-options.js`:

```js
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
export function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
```

With `contextWindow = 131072 − 32768 = 98,304`:

- **pi can never send more than `98,304 − 4,096 = 94,208` tokens total.** Measured
  ceiling across the 24 truncated turns was 94,081–94,381 (estimator drift). Confirmed.
- Compaction fires at `contextWindow − reserveTokens = 98,304 − 16,384 = 81,920`
  (`compaction.js: contextTokens > contextWindow − settings.reserveTokens`).
- The gap between "compact" and "clamp to 1 token" is `reserveTokens − CONTEXT_SAFETY_TOKENS
  = 12,288` tokens, **regardless of `headroom`**.

Any single tool result larger than ~12k tokens jumps the session straight over the
compaction threshold into the clamp. Result, in this run:

```
stopReason distribution (1287 assistant turns):
  toolUse 1164 | stop 91 | length 24 | error 6 | aborted 2
```
24 `length` turns (1.9%), **15 of them with `output: 1`**. Each burns a ~94k-token
prefill to emit one token, then `isRecoverableLength` triggers a compaction and a retry.
Inputs on those turns: 90,971 – 106,797.

vLLM's own view agrees: `request_success_total{finished_reason="length"} = 124` of 3,201
(3.9%).

`reserveTokens` is a settable pi setting (`settings.compaction.reserveTokens`, default
16384; also `settings.branchSummary.reserveTokens`) — `settings-manager.js:
getCompactionReserveTokens()`.

## 7. Malformed tool calls — 120 in 14.3 h

Counted across the live session tree:

| tool | count | failure |
| --- | ---: | --- |
| `edit` | 81 | `edits.0: must be object` (27) or missing everything (empty args) |
| `write` | 39 | `path: must have required properties path` |
| `get_search_content` | 3 | — |

Two distinct modes:
- **46 calls arrived with literally `{}` for arguments** — total parse failure.
- **27 calls had an array/object parameter delivered as a JSON *string***, e.g.
  `"edits": "[{\"newText\": ...}]"` instead of an array.

This matters because it matches a known upstream bug — see `02-vllm-and-model.md` §3.

## 8. What the alias removal (PR #148) actually fixed

Pre-fix session `--var-lib-paseo-worktrees-25trkhou-mundane-horse--` (2026-08-30),
`headroom = 20480`, the `-48k`/`-44k` fan-out alias live:

- **27 hard `400 BadRequestError` context overflows**, every one totalling exactly
  131,073 = `max_model_len + 1`.
- Two `reviewer` subagent runs on `Qwen3.8-27B-NVFP4-44k:high` died with
  `"Subagent produced no output after terminal assistant stopReason \"length\""` —
  exactly the 8192-`maxTokens` truncation the commit message predicted.

Post-fix, across 14.3 h and 3,201 requests: **zero 400s, zero `-44k` runs.** The fix
worked. What remains is the softer §6 clamp, which the alias removal did not address.
