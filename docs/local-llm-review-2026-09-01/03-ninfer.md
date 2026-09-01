# NInfer evaluation

Repo: <https://github.com/Neroued/ninfer> (Apache-2.0). Docs: `README.md`, `docs/cli.md`,
`docs/serving.md`, `docs/performance.md`.

## What it is

A from-scratch C++20/CUDA inference engine for a **closed set of registered Qwen
checkpoints** on a **single RTX 5090**. Not a general runtime: one GPU, one resident model,
startup-fixed capacity of 1–8 active requests. Two binaries: `ninfer` (one-shot) and
`ninfer-serve` (server).

The fit with this stack is uncomfortably good:

| | this stack | NInfer |
| --- | --- | --- |
| GPU | RTX 5090, 31 GiB, dedicated | RTX 5090 only; build rejects anything but `sm_120a` |
| Model | `unsloth/Qwen3.8-27B-NVFP4` | Qwen3.8-27B **nvfp4** is a registered artifact (weights derived from unsloth's repo) |
| Reasoning effort | `medium` / `xhigh` via chat-template kwargs | native `--reasoning-effort low\|medium\|xhigh` |
| Spec decoding | MTP, 3 draft tokens | `--spec mtp --draft-tokens 1..5`, plus `--lm-head-draft` |
| KV | fp8 | `--kv-dtype bf16\|int8\|fp8` |
| Context | 131,072 | 262,144 (131,072 for Qwen3.8 MTP3) |
| Concurrency | `--max-num-seqs 2` | `--max-concurrency 1..8` + bounded pending queue |

It also registers Qwen3.6-27B (int + nvfp4) and Qwen3.6-35B-A3B — i.e. the whole catalog
in `models.nix`, including the parked fallback.

## Published performance (docs/performance.md, RTX 5090, INT8 KV)

**Qwen3.8-27B NVFP4, corpus makespan:** peak at **C=4, 2.83× speedup vs C=1**, decode
432.9 tok/s aggregate, MTP acceptance ~57–61%.
Qwen3.8-27B groupwise-int: C=8 gives 2.09×, 315.3 tok/s, ~58–59% acceptance.
Qwen3.6-27B NVFP4: C=8 aggregate decode 1,147 tok/s, 68.6% acceptance; prefill
11,192 → 2,511 tok/s as context grows; server TTFT 693 ms → 103.8 s.

**Caveats before treating that as a comparison.** These are the project's own benchmarks,
no vLLM baseline is published, KV dtype is INT8 not fp8, and "corpus makespan" is a batch
benchmark, not an interactive agent trace. Our measured stack is doing 97.9 tok/s aggregate
decode with 67.9% MTP acceptance — *better* acceptance than NInfer reports for the same
model. The credible part of the claim is the **concurrency scaling shape**, which is where
this stack is currently losing (see `01-measurements.md` §3).

## The genuinely attractive parts

1. **`--max-concurrency 1..8` with real batching.** Our measured knee is at 3 in-flight
   against a cap of 2. NInfer's own numbers put the sweet spot for this exact model at
   C=4. Same lever, better default.
2. **`--request-log-jsonl FILE`, schema v18.** Per-request `prepare / ttft / vision /
   prefill / decode / total` seconds, `queue_wait_seconds`, prompt/completion/**cache**/
   prefill token counts, speculative `drafted_tokens` / `accepted_tokens` / `fallback_steps`,
   and a named **prefix-reuse path** (`root`, `shared_stable_prefix`, `private_turn_closure`,
   …). No response text logged, API keys redacted. This is strictly better than what vLLM
   exposes, and it reports the cached-token count vLLM has been unable to report for 14+
   months (`02-vllm-and-model.md` §5).
3. **Bounded queue with real backpressure.** `--max-pending-requests` (default 16),
   `--pending-timeout-ms` (default 30 s), HTTP 429 `server_overloaded` at capacity, 503
   `request_queue_timeout` on deadline. Today vLLM queues unboundedly and we observed
   up to 16 in flight and 480 s of pure queue wait — invisible as anything but latency.
4. **Native `reasoning_effort`** on `/v1/chat/completions`, values `none|low|medium|xhigh`,
   which is exactly the set `models.nix` already folds pi's levels onto.
5. **`--host-kv-mib`** pinned-host KV overflow — a lever vLLM does not offer here.
6. **Anthropic `/v1/messages` + token counting**, and OpenAI `/v1/responses`, alongside
   Chat Completions.

## The blockers

1. **Build from source, no binaries, no nixpkgs package.** Confirmed: `pkgs ? ninfer` is
   `false`. Needs CUDA 13.1+, CMake 3.28+, C++20, Ninja, FFmpeg dev libs (libavformat ≥60,
   libavcodec ≥60, libavutil ≥58, libswscale ≥7), libcurl ≥7.85, pkg-config. Packaging that
   in nix is real work — and note the existing setup deliberately does *not* build vLLM in
   nix ("nix build OOMs on 32GB and nixpkgs lags upstream"), it consumes an upstream OCI
   image. There is no upstream OCI image for NInfer.
2. **`chat_template_kwargs` is rejected for unknown keys.** Only `preserve_thinking` is
   accepted. pi is currently configured with `thinkingFormat = "chat-template"` and sends
   `enable_thinking` + `reasoning_effort` *inside* `chat_template_kwargs`. That config would
   have to move to top-level `reasoning_effort`, and sending both at once returns
   `conflicting_template_option`. Concrete, small, but it is a change in `settings.nix`, not
   a drop-in swap.
3. **Weights are separate artifacts.** Derived from unsloth's repo but re-packed and hosted
   under the maintainer's HF account. New repo, new file list, new sha256s in `models.nix`,
   and the existing weights stay resident for whichever engine you keep — plan for both on
   disk during any A/B.
4. **No preemption, no priority QoS, no active-request swapping, no weight offload, no
   multi-GPU.** Fine for a dedicated single-card box; worth knowing.
5. **No structured outputs / JSON-constrained decoding, no strict tool mode, no required or
   named `tool_choice`, no logprobs.** pi does not appear to need any of these today —
   `--enable-auto-tool-choice` maps to NInfer's `auto`. But `strict: true` tool schemas
   would be a hard stop if a plugin ever wants them.
6. **Maturity is unknown.** No stars/contributors/release cadence in the docs, no stability
   or production-readiness statement, no third-party benchmarks, and community forks exist
   for 3090 and Windows (a health signal, but also a signal that this is a hobby-scale
   project). vLLM's 0.28.0 shipped 584 commits from 270 contributors.
7. **`--max-context` default is 2048 (CLI) / 8192 (serve)** and `--kv-capacity` defaults to
   `--max-context`. Easy to misconfigure into something that silently truncates; `auto`
   exists for the pool.

## Recommendation

**Do not migrate now. Do build a bench.**

The case for NInfer rests on concurrency scaling and observability. But the measured
bottleneck — `--max-num-seqs 2` — is a one-token change in `models.nix`, and the
observability gap turned out to be reachable through llama-swap's `/upstream` proxy. Both
of the things NInfer would buy you are available for near-zero cost on the engine you
already run. Spend that first and re-measure.

What makes NInfer worth revisiting rather than dismissing: it is the only engine that
targets *precisely* this hardware and this checkpoint, its request-log schema is the
observability you actually want, and if the vLLM 0.28.0 bump does **not** clear the
malformed-tool-call rate, "hybrid + prefix cache + MTP is fragile in vLLM" becomes a
standing correctness argument rather than a one-off bug.

Cheap next step, no commitment: build it in a scratch container on redtruck against the
existing weights and run `ninfer-serve --max-concurrency 4 --spec mtp --draft-tokens 3
--kv-dtype fp8 --request-log-jsonl /tmp/ninfer.jsonl`, point one devbox at it for a day,
and diff the JSONL against `data-llamaswap-activity-1000req.tsv`. That is a day of work
and it answers the question with your own workload instead of someone else's benchmark.
