# Plan — NInfer vs. vLLM 0.28.0 on Qwen3.8-27B-NVFP4, RTX 5090

Status: **complete, 2026-09-03.** All five agents ran; `01`–`04` are the audit trail and
**[`00-VERDICT.md`](00-VERDICT.md)** is the deliverable. Verdict: **no-go on migrating to
NInfer**, with the flip condition stated there. Two vLLM-side experiments — the
`qwen3_coder`/`qwen3_xml` parser confound, and an image containing vllm#50729, which does not
exist as a published artifact — dominate the comparison and should run first. No config was
changed by this study.

## The question

Direct, decision-grade comparison of the running stack (vLLM 0.28.0, Qwen3.8-27B-NVFP4,
MTP off, prefix caching on) against [NInfer](https://github.com/Neroued/ninfer), on three
axes the user named:

1. **Concurrency / batching.** What can NInfer actually run in parallel on this card, and
   is its batching better than `maxNumSeqs = 3` against a measured
   `kv_cache_max_concurrency` of **2.07**?
2. **The MTP x prefix-cache bug class.** vLLM poisons cached state because draft-token
   rollback cannot restore a mamba recurrent snapshot. **Does NInfer have the same hazard,
   or is it structurally immune?** This is the highest-value question and gets the most
   agent budget.
3. **Estimated speeds.** Prefill tok/s, decode tok/s, TTFT, and cache-hit behaviour,
   normalized to *this* workload (56:1 input:output, ~64k input per turn, 82% prefix hits)
   rather than to NInfer's own corpus-makespan benchmark.

### Scope boundary

This is a **desk study producing estimates**, per the ask. It does **not** build NInfer or
run an A/B on redtruck. The final deliverable ends with a concrete bench recipe so that
step is a decision, not a rediscovery.

## Why re-run this at all

`docs/local-llm-review-2026-09-01/03-ninfer.md` reached "don't migrate now, do build a
bench" two days ago. Two of its load-bearing premises are now false:

| 2026-09-01 premise | State on 2026-09-03 |
| --- | --- |
| Stack runs MTP, 67.9% acceptance, *better* than NInfer's 57-61% | MTP removed in #156. That comparison no longer exists. |
| "The bottleneck is `--max-num-seqs 2`, a one-token fix" | Now 3. Fix is spent; `kv_cache_max_concurrency` 2.07 says the pool, not the cap, now binds. |
| MTP x prefix-cache is "a one-off upstream bug, baseline before switching" | We removed MTP rather than fix it, and TPOT doubled. It is now a standing cost, which is exactly NInfer's opening. |

So the old verdict was reached under conditions that no longer hold, and the axis the user
cares about (does NInfer let me have MTP *and* prefix caching?) was never asked.

## Live baseline captured while drafting this (2026-09-03)

From `curl -s https://llm.mist-gamma.ts.net:8443/metrics` — the endpoint is directly
reachable from the worktree host, no llama-swap proxy needed.

```
prompt_tokens_total          84,696,435
  local_cache_hit            69,434,176   = 82.0%
  local_compute              15,262,259
generation_tokens_total       1,979,387
num_preemptions_total               197
kv_cache_size_tokens            211,911   block_size 1568, mamba_block_size 16
kv_cache_max_concurrency           2.07   <-- against maxNumSeqs = 3
cache_dtype                         fp8   enable_prefix_caching True, mamba_cache_mode align
vllm:spec_decode_*                absent   <-- confirms MTP is off in the running engine
```

Counters are since the post-#156 restart, so this **is** the post-MTP-removal soak. Agent
S1 re-captures it properly with histograms and a fresh concurrency fit.

## Agent dispatch

Five agents, three waves. Each writes exactly one file and no two agents write the same
file, so there is no write contention. State lives in this directory.

### Wave 1 — parallel, 3 agents

| # | Agent | Model | Writes | Job |
| --- | --- | --- | --- | --- |
| S1 | Baseline scout | **Sonnet** | `01-baseline-vllm.md` | Mechanical capture, no judgement. Scrape `/metrics` in full to `data-vllm-2026-09-03.prom`. Derive TTFT / TPOT / e2e means from the histograms, aggregate + per-stream decode tok/s, effective vs. compute prefill rate, preemption rate per request, queue-time distribution. Re-fit `duration ~ a*input + b*output + c` on uncontended requests if a per-request source exists post-llama-swap; say plainly if it does not. Diff every number against `docs/local-llm-review-2026-09-01/01-measurements.md` and flag what MTP removal moved (esp. TPOT). |
| R1 | NInfer architecture | **Opus** | `02-ninfer-architecture.md` | Read the actual repo + `docs/{cli,serving,performance}.md`. Extract: scheduler and batching model (continuous vs. static, is `--max-concurrency` a startup allocation or a cap), prefix-reuse implementation and its named paths, KV layout and dtypes, spec-decode implementation, context/capacity flags and defaults, API surface, build requirements. **Re-verify** each claim in `03-ninfer.md` against current HEAD and report drift. Note commit recency, release cadence, contributor count — maturity was an open blocker. |
| R2 | Correctness / bug class | **Opus** | `03-mtp-prefix-cache-correctness.md` | The headline question. First state the *mechanism* precisely: why draft rollback cannot restore mamba recurrent state, what vLLM #47194 / #51113 / #50991 each actually changed, and whether #47194 is still open. Then test NInfer's design against that same mechanism from its source: does it snapshot recurrent state per step, what does it do on draft rejection, does its prefix cache store recurrent state or recompute it, do the reuse-path names (`shared_stable_prefix`, `private_turn_closure`) imply a safe or unsafe reuse. Verdict must be one of: structurally immune / same hazard / cannot tell from available evidence, with the evidence quoted. **No speculation dressed as a finding.** |

### Wave 2 — 1 agent, after Wave 1

| # | Agent | Model | Writes | Job |
| --- | --- | --- | --- | --- |
| R3 | Performance projection | **Opus** | `04-performance-projection.md` | Reads `01`, `02`, `03`. Takes NInfer's published numbers (C=4 peak, 2.83x vs C=1, 432.9 tok/s aggregate decode, MTP acceptance 57-61%, prefill 11,192 -> 2,511 tok/s as context grows) and **renormalizes them to our workload**, correcting for: INT8 KV in their bench vs. fp8 here, corpus-makespan batch shape vs. interactive 56:1 agent traffic, 82% prefix-hit rate, ~64k input turns, and the fact that we now run *without* MTP. Output a table of estimated prefill / decode / TTFT / effective concurrency with an explicit uncertainty band and a named reason per row. Must state which numbers are ours, which are theirs, and which are inferred. |

### Wave 3 — 1 agent, after Wave 2

| # | Agent | Model | Writes | Job |
| --- | --- | --- | --- | --- |
| V1 | Verdict synthesizer | **Opus** | `00-VERDICT.md` + rewrite of this file's status | Consumes `01`-`04`. Produces: the side-by-side comparison table; a straight answer to each of the three questions; what NInfer buys and what it costs (build-from-source, no OCI image, separate weight artifacts, `chat_template_kwargs` rejection forcing a `settings.nix` change, no structured outputs, unknown maturity); a go / no-go with the condition that would flip it; and a one-day bench recipe if the answer is "measure it." Must **name any disagreement between the wave-1 agents** rather than smoothing it over, and must not invent numbers absent from `01`-`04`. |

## Model rationale

No Fable anywhere, per instruction. Opus is the ceiling and is spent on the three jobs
that are genuinely hard: reading unfamiliar C++/CUDA to answer a correctness question (R2),
reading an unfamiliar codebase's scheduler (R1), and cross-source synthesis under
uncertainty (R3, V1). S1 is deterministic scrape-and-arithmetic against a known endpoint
with a known prior document to diff against, so Sonnet is the right tier there — spending
Opus on curl and division buys nothing. Reasoning effort inherits the session's high.

## Rules the agents get

- Findings go in the assigned file only. Never edit another agent's file.
- Every claim is either measured (give the command), quoted from source (give the path or
  URL), or labelled an estimate with its basis. No fourth category.
- "Cannot determine from available evidence" is an acceptable and preferred finding.
- Contradicting `docs/local-llm-review-2026-09-01/` is expected — MTP removal changed the
  ground. Say so explicitly when it happens.
- Do not modify anything under `modules/`. This study changes no config.

## What you get at the end

`00-VERDICT.md`: the direct comparison, the three answers, and a go/no-go with its
flip condition. Supporting files stay for audit.
