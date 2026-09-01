# Local LLM stack review — 2026-09-01

Question asked: now that the fan-out alias is gone and context limits can be set in pi's
config, is llama-swap still worth keeping, is NInfer worth moving to, and what should
change in the vLLM / Qwen3.8 setup for local agentic coding?

**Start with [`04-change-and-keep.md`](04-change-and-keep.md)** — that is the deliverable.

| File | What is in it |
| --- | --- |
| [`01-measurements.md`](01-measurements.md) | Everything measured, with the commands to re-run it. Read this before disagreeing with anything else. |
| [`02-vllm-and-model.md`](02-vllm-and-model.md) | Current vLLM/model config, what holds up, what doesn't, and the upstream correctness bug in the running flag combination. |
| [`03-ninfer.md`](03-ninfer.md) | NInfer evaluation. Verdict: don't migrate now, do build a bench. |
| [`04-change-and-keep.md`](04-change-and-keep.md) | **The list.** 9 changes ranked by measured value, 10 keeps, 4 don'ts. |
| [`05-nix-update-plan.md`](05-nix-update-plan.md) | **The plan.** 3 PRs, sequenced, with diffs and a verification signal for each. |
| [`06-llama-swap-removal.md`](06-llama-swap-removal.md) | Removing llama-swap: why the keep verdict failed, what replaces it, what we lose. |
| `data-llamaswap-activity-1000req.tsv` | Raw: 1000 server-side requests (completion ts, duration ms, input, output, status). |
| `data-vllm-metrics-snapshot.txt` | Raw: full `vllm:` Prometheus scrape, 2026-09-01 ~10:25 local. |

## The three findings that reframe everything

1. **Prefill is nearly free.** 78% of prompt tokens are served from prefix cache
   (`prompt_tokens_cached_total 151,059,200 / prompt_tokens_total 193,667,242`). Input
   costs ~2 µs/token at the request level. The workload is 56:1 input:output, so this
   looks like it should be prefill-bound — it isn't. **Decode is 68.6% of latency.**
   Nearly every tuning comment in `models.nix` optimizes the wrong thing.

2. **`--max-num-seqs 2` is the bottleneck, and the knee is exactly at 3.** Going from 1 to
   2 concurrent requests is free (9.7 → 9.8 s per 1k output tokens). The third — the first
   that must queue — costs +27%, the fourth +89%, six or more +260%. 55% of requests
   arrive with ≥3 in flight. Preemption is already running at ~1 per request, so the low
   cap isn't even buying preemption-freedom.

3. **The running flag combination has a named upstream correctness bug.** Qwen3.x hybrid +
   prefix caching + `mamba-cache-mode align` + MTP is vLLM #47194 / PR #47861:
   "tool-call leakage, recall failures, and degenerate generations on cache-hit paths."
   Measured here: 120 malformed tool calls in 14.3 h, 46 with empty arguments.

   Upstream status verified 2026-09-01: the merged fix is **PR #51113**, and **v0.28.0 is
   the first release containing it** (not v0.27.x — those branches were cut earlier). It
   closed the accuracy-drop report #43559; **the tool-call-leakage report #47194 is still
   open.** So the bump to 0.28.0 is well-founded, but it is an experiment for our symptom
   rather than a promised fix — baseline before switching.

## Two things that were reachable all along

- vLLM's full Prometheus metrics, via `curl
  https://llm.mist-gamma.ts.net:8443/upstream/Qwen3.8-27B-NVFP4/metrics`. llama-swap
  proxies them. Every number the tuning comments guess at is in there.
- A per-request token+duration history, via `/api/metrics/activity`. Note its `timestamp`
  is *completion* time — subtract `duration_ms` to get the start, or every concurrency
  number comes out wrong.
