# NInfer vs. vLLM for the redtruck local-LLM stack — Spike

**Date:** 2026-08-30
**Upstream:** https://github.com/Neroued/ninfer (Apache-2.0, created 2026-06-26, 1,174 stars, 213 forks, 30 open issues, 3 contributors, no tagged releases, last push 2026-08-30)
**Status:** research only — nothing in this repo is wired up.

## 1. What NInfer actually is

A from-scratch C++/CUDA inference engine — not a model, not a fine-tune, not a coding
tool. ~100k lines across `src/` + `apps/`, vendoring only `cpp-httplib`, `nlohmann/json`
and `utf8proc`. It replaces vLLM in the stack; it does not replace the model.

The scope is deliberately narrow, and the narrowness is the whole point:

- one GPU, **RTX 5090 only** — `CMakeLists.txt:9` hard-fails any
  `CMAKE_CUDA_ARCHITECTURES` other than `120a`;
- one resident model per process, no runtime model discovery;
- startup-fixed `1..8` active-request lanes, no preemption, no multi-GPU;
- five registered artifacts, each a single `.ninfer` blob with tokenizer, chat template
  and media frontend embedded.

### It runs *our* exact weights

`Qwen3.8-27B nvfp4` is derived from **`unsloth/Qwen3.8-27B-NVFP4`** — byte-for-byte the
repo in `modules/local-llm/models.nix:9`. So this is not "a similar model"; it is a
different engine over the same checkpoint.

| Artifact | Size | Notes |
|---|---:|---|
| `qwen3_8_27b_nvfp4.ninfer` | 20.02 GiB | our current weights |
| `qwen3_8_27b.ninfer` (groupwise-int) | **16.96 GiB** | ~3 GiB more room for KV |

## 2. "Is this for coding?"

No — and the good results you're seeing are the *model's*, which we already run.

NInfer's published evals (AIME 2025/2026, GPQA-Diamond, ERQA, RealWorldQA) contain **no
coding benchmark** — no SWE-bench, no LiveCodeBench. They measure the Qwen3.8 checkpoint,
not the engine. An engine swap does not change capability; it changes latency, throughput,
and memory.

There is exactly one coding-specific data point upstream, and it is interesting:
[issue #119](https://github.com/Neroued/ninfer/issues/119), opened today, on an RTX 5090:

| Qwen3.8-27B artifact | code decode | MTP3 acceptance |
|---|---:|---:|
| groupwise-int MTP3 | **171.7 tok/s** | 84.2% |
| nvfp4 MTP3 | 152.2 tok/s | 71.6% |

On code the NVFP4 target disagrees with its own embedded MTP draft more than groupwise-int
does, so speculation pays off less. On JSON and prose the two are within ~5% and NVFP4 wins.
Combined with the size table above, **groupwise-int is the artifact worth testing first for
pi**, which is the opposite of what we concluded for vLLM. Caveat: NInfer's own concurrency
table shows groupwise-int scaling much worse than NVFP4 at C>1 (for 3.6-27B: 2.88x vs 5.67x
at C=8), and our subagent fan-out runs at C=3 — so measure both, don't assume.

Upstream's own Qwen3.8-27B NVFP4 numbers on a 5090, for calibration
(`docs/performance.md`, MTP3, INT8 KV, C=1):

| Category | Decode tok/s | MTP acceptance |
|---|---:|---:|
| Code | 194.3 ± 6.1 | 76.4% |
| Structured | 219.8 ± 8.6 | 90.8% |
| Story | 126.1 ± 10.9 | 37.4% |

## 3. Fit with the current setup

`modules/local-llm/` is in good shape for this. `llama-swap.nix` already builds a
per-model `cmd:` block, `weights.nix` already fetches from HF into the store, and
llama-swap health-checks by connecting until the port answers. `ninfer-serve` binds
**after** the model is fully loaded (`apps/serve/main.cpp:129-135`), so that pattern works
unchanged.

### What maps cleanly

| Today (vLLM) | NInfer equivalent |
|---|---|
| `--served-model-name Qwen3.8-27B-NVFP4` | `--model-id Qwen3.8-27B-NVFP4` |
| `--max-model-len 131072` | `--max-context 131072` |
| `--kv-cache-dtype fp8` | `--kv-dtype fp8` |
| `--max-num-seqs 3` | `--max-concurrency 3` |
| `--speculative-config '{"method":"mtp","num_speculative_tokens":3}'` | `--spec mtp --draft-tokens 3 --lm-head-draft` |
| `--enable-auto-tool-choice --tool-call-parser qwen3_coder` | built in (tools parsed, never executed) |
| `--reasoning-parser qwen3` | built in (`reasoning_content`) |
| `--override-generation-config '{"temperature":1.0}'` | **nothing** — NInfer's registered Qwen3.8 thinking defaults are already `1.0 / 0.95 / 20 / 0 / 0`, identical to `models.nix` `sampling` |
| `--limit-mm-per-prompt '{"image":0,"video":0}'` | **nothing** — vision is off by default and its allocations are never made |
| aliases + `useModelName` in llama-swap | unchanged; llama-swap rewrites the model field before it reaches NInfer |
| `healthCheckTimeout: 900` | can drop hard — C++ mmap load, not a Python cold start |

`--limit-mm-per-prompt` deserves a note: today we pass it because *the vision encoder's
profiling buffers OOM'd startup*. NInfer's vision weights and workspace extent are simply
not allocated without `--vision`, so that class of failure disappears rather than being
worked around.

### What breaks and needs a decision

1. **`reasoning_effort` moves out of `chat_template_kwargs`.**
   `modules/pi-coding-agent/settings.nix:91` sets `thinkingFormat = "chat-template"`, which
   makes pi send `chat_template_kwargs.reasoning_effort`. NInfer accepts **only**
   `enable_thinking` and `preserve_thinking` there and **rejects every other non-null
   `chat_template_kwargs` key with HTTP 400** rather than ignoring it (`docs/serving.md`).
   Fix: drop `thinkingFormat` and the `chatTemplateKwargs` block entirely. The default
   branch in `openai-completions.ts:839` then sends top-level `reasoning_effort`, still
   mapped through `thinkingLevelMap`. NInfer's Qwen3.8 template exposes exactly
   `low` / `medium` / `xhigh`, which is exactly what our map emits — so
   `models.nix` `thinkingLevels` is unchanged. Everything else that block does is preserved.

2. **`thinking_token_budget` silently stops working.**
   It is a vLLM extension; NInfer ignores unknown top-level fields. The nearest equivalent
   is the process-wide `--default-thinking-budget N`, which is one value for the model *and*
   its 48k alias. pi currently computes 8192 (medium) / 16384 (xhigh) clamped to leave answer
   room, and the alias only has `maxTokens = 8192`. A single safe value is ~6144, which costs
   xhigh depth on the main window. Note NInfer 400s with
   `thinking_budget_capacity_insufficient` if the budget doesn't leave room for the close
   marker plus one token — so this must be set deliberately, not guessed. Set
   `supportsThinkingTokenBudget = false` so pi stops sending a dead field.
   (The `anthropic-messages` route honours per-request `thinking.budget_tokens`, but pi only
   sends effort there under `forceAdaptiveThinking`, which then drops the budget. Not worth it.)

3. **`--pending-timeout-ms` defaults to 30 s and will bite.**
   `models.nix:33-40` currently reasons about overcommit as *"vLLM resolves that by preempting
   one sequence."* NInfer has **no preemption**: admission reserves the full prompt-plus-output
   page entitlement up front, and a request that can't fit waits in a bounded FIFO. Past
   `--pending-timeout-ms` it returns HTTP 503 `request_queue_timeout`; past
   `--max-pending-requests` (default 16) it returns HTTP 429 `server_overloaded`.
   A subagent fan-out where one lane is decoding 8k tokens at ~150 tok/s occupies its lane
   for ~55 s — far past the 30 s default. This needs raising to minutes.
   Arguably the resulting behaviour (queue, then serve) is *better* than preemption thrash,
   but it is a different failure mode and the timeout must be set for it.

4. **No constrained decoding, ever.** `response_format` / json_schema / grammar are rejected
   by design ([issue #33](https://github.com/Neroued/ninfer/issues/33)). pi never sends them
   today, so this is a ceiling, not a blocker.

5. Non-issues I checked so we don't re-check them: pi never sets `tool_choice` (only its
   vendored tests do), so NInfer's rejection of `required`/named choice doesn't apply;
   `stream_options.include_usage`, `max_tokens`, `top_k: 20`, `min_p: 0`, `top_p: 0.95` and
   `store: false` are all accepted; `prompt_cache_key` is accepted as advisory. The artifact
   reader opens with `O_DIRECT` and no fallback (`src/artifact/reader.cpp:180`) — redtruck's
   filesystems are all ext4, so that's fine, but it would fail on ZFS/tmpfs.

## 4. Measured vLLM baseline, and the free win we're leaving on the table

Captured from the live redtruck vLLM (v0.26.0, Qwen3.8-27B NVFP4, fp8 KV, MTP3,
`maxNumSeqs = 3`) on 2026-08-30 13:20-13:21. Every interval reports `Running: 1 reqs,
Waiting: 0` — this is single-stream, no batching exercised.

| Interval | Gen tok/s | Mean accept len | Draft accept | **Implied rounds/s** |
|---|---:|---:|---:|---:|
| 13:20:28 | 114.4 | 3.25 | 74.9% | 35.2 |
| 13:20:38 | 155.1 | 3.71 | 90.4% | 41.8 |
| 13:20:48 | 152.5 | 3.65 | 88.3% | 41.8 |
| 13:20:58 | 166.1 | 3.98 | 99.4% | 41.7 |
| 13:21:08 | 151.1 | 3.62 | 87.5% | 41.7 |

Dividing out acceptance gives the engine's actual step rate, and it is remarkably stable:
**~41.8 MTP rounds/s, ~24.0 ms per round.** NInfer's published Qwen3.8-27B NVFP4 tables are
equally stable at **~59 rounds/s, ~17 ms per round** (Code 194.3 tok/s ÷ 3.29 tok/round;
Structured 219.8 ÷ 3.72; Story 126.1 ÷ 2.12 — all land on 59).

So the clean engine-vs-engine number, independent of workload and acceptance, is
**NInfer's decode step is ~1.4x faster**. Applying our *observed* acceptance (3.62-3.98) to
NInfer's step rate projects **~215-235 tok/s against our current 151-166**, roughly **+40%**.
That projection is optimistic in one specific way: our acceptance (87-99%) is far above
NInfer's published code acceptance (76.4%) and above [issue #119](https://github.com/Neroued/ninfer/issues/119)'s
NVFP4 code figure (71.6%). At NInfer's own 3.29 tok/round the gain is only +17-28%.

Two other things the log says loudly:

- **`GPU KV cache usage: 10.3% - 24.8%`.** We are using a fifth of the pool. The
  "NInfer's weights are 1.8-4.8 GiB smaller" argument in §7 is therefore close to worthless
  *today* — more KV headroom buys nothing when the existing headroom is idle. It only starts
  mattering if concurrency or context goes up.
- **`Prefix cache hit rate: 0.0%`**, against `Avg prompt throughput` spikes of 2,012 and
  3,954 tok/s — roughly 20k and 40k prompt tokens re-prefilled inside single 10-second
  windows. Prefill is eating a large fraction of every turn's wall clock, and it is the
  biggest number in the log by a wide margin.

### The 0.0% is very likely fixable on vLLM, for one flag

`models.nix:33` says *"no prefix caching — vLLM auto-disables it for this hybrid-attention
model."* The behaviour is real but the conclusion is wrong. vLLM v0.26.0,
`vllm/engine/arg_utils.py:2518-2523`:

```python
# Hybrid models support prefix caching but keep it opt-in for now
# while the feature matures.
default_prefix_caching = (
    model_config.is_prefix_caching_supported and not model_config.is_hybrid
)
```

It is **supported and off by default**, not unsupported. Mamba/GDN prefix caching landed via
`mamba_cache_mode` (`vllm/config/cache.py:139-147`, modes `none`/`all`/`align`), and vLLM has
defaulted Mamba-based models to `align` when speculative decoding is enabled since
[`f819265a`](https://github.com/vllm-project/vllm/commit/f819265a) (2026-04-21) — three
months before the v0.26.0 we pin. Our config is exactly that case: hybrid model + MTP.

So the cheapest experiment in this whole document is a one-line change to
`llama-swap.nix:vllmArgs`:

```
"--enable-prefix-caching"
"--mamba-cache-mode align"
```

Caveats, in order of likelihood:

- **`align` asserts `block_size <= max_num_batched_tokens`** (`vllm/config/vllm.py:2265-2271`).
  We pass `--max-num-batched-tokens 2048`, and vLLM raises the attention block size to match
  the mamba page size (528 tokens on Qwen3.5-4B; unknown for 27B). If the aligned block size
  exceeds 2048 this asserts at startup — raise `maxNumBatchedTokens` and retry.
- **Correctness.** vLLM's own comment says "opt-in for now while the feature matures", and
  `models.nix:157` records that prefix caching *"caused incoherent rewrite loops on long
  sessions"* on Qwen3.6. That was a different model on an older vLLM without align mode, so
  it deserves a retry — but watch for it.
- Block granularity only hurts prompts shorter than the block size
  ([vllm#40696](https://github.com/vllm-project/vllm/issues/40696)). Our prompts are 20-40k
  tokens, so hit rates should be near-total.

**Do this before anything in this document.** If it works, it captures the single largest win
NInfer offers, on the engine we already run, with no download and no new dependency — and it
reduces NInfer's remaining pitch to "+17-40% decode, vision, and fast startup."

### What NInfer still offers if vLLM prefix caching works

NInfer implements exact-prefix reuse for this architecture by replaying the GDN/SSM recurrent
state, not just KV (`docs/maintainer/replayssm-gdn.md`, the technique SGLang used for
Kimi K3), tiering checkpoints across Device and pinned Host memory and naming the path taken
in its log (`private_endpoint`, `private_turn_closure`, `shared_stable_prefix`). vLLM's align
mode caches mamba state only at block boundaries and only for completed blocks; NInfer's
checkpoints are exact frontiers with Host-memory spill. It is plausibly better. It is also
entirely unquantified — upstream publishes no hit-vs-miss TTFT delta, only a harness
(`tools/bench/ttft/`).

Upstream's no-reuse prefill cost, for sizing what reuse is worth on either engine:

| Prompt tokens | Prefill tok/s | Server TTFT |
|---:|---:|---:|
| 7,680 | 8,340 | 0.93 s |
| 64,512 | 5,298 | 12.3 s |
| 130,048 | 3,545 | **36.9 s** |
| 260,096 | 2,203 | 118.4 s |

## 4b. Field reports from agentic users — this is the decisive evidence

Upstream's issue tracker contains direct measurements from people running NInfer behind
tool-calling coding agents. They are worth more than every benchmark table in this document,
because they are our workload.

### [#62](https://github.com/Neroued/ninfer/issues/62) / [#77](https://github.com/Neroued/ninfer/issues/77) — Cline agentic coding, Qwen3.8-27B NVFP4, single client

`ninfer-serve`'s own request log across one real task, 439 requests:

| Reuse path | Share | TTFT |
|---|---:|---:|
| `append_frontier` | 353 (80%) | **270-300 ms** |
| `restore_turn_checkpoint` | 71 (**16%**) | **30,000-36,000 ms** |
| `full_reset` | 15 (3%) | — |

The 80% case is spectacular — near-total reuse at sub-300 ms. The 16% case is the problem.
`cache=` pins at a small fixed value while `prompt=` keeps growing; one run held `cache=6887`
across five consecutive requests while the prompt grew 136,133 -> 149,705 tokens,
reprocessing the whole difference each time.

Root cause, traced by the reporter: `last_real_user_query()` in `chat_template.cpp` anchors
the rewrite checkpoint immediately after the last *human-typed* turn, explicitly skipping
`<tool_response>` messages. In a long autonomous tool loop — `assistant -> tool -> assistant
-> tool`, 50+ deep, no human turn in between — the checkpoint never advances. Any single
`append_frontier` failure rewinds to loop start. This is **not a bug**: `test_rewrite_checkpoint_trace`
in `tests/targets/qwen3_6/test_frontend.cpp` asserts exactly this behaviour.

**pi is exactly this client shape.** Our subagents run long tool loops with no human turn
between them.

### Same reporter's A/B, after switching away

Same machine, same Cline traffic, 100K-125K accumulated context:

| llama.cpp `llama-server` (LCP prefix matching) | |
|---|---|
| LCP similarity | min 0.919, max 0.999 — never below 92% |
| `prompt eval time` | median ~1.7 s, 1 of 30 over 5 s |

Their conclusion, verbatim: *"For anyone else evaluating ninfer for agentic/tool-calling
coding assistants specifically: right now this makes it a genuine no-go for that use case,
not a rough edge to work around — the raw decode-speed advantage doesn't matter much when 1
in 6 turns eats a 30+ second stall waiting on prefill that should've been cacheable."*

The architectural point generalises: **llama.cpp and vLLM do dynamic longest-common-prefix
matching per request and find the divergence wherever it actually is. NInfer requires a
pre-declared checkpoint boundary, and its boundary model assumes turns end at human
messages.** That assumption is wrong for every agent.

### A second, independent report ([#62](https://github.com/Neroued/ninfer/issues/62), robotics, Qwen3.6-35B-A3B, concurrency 1)

| | NInfer | vLLM 0.27.1 |
|---|---:|---:|
| `full_reset` rate | 121 of 124 requests | — |
| `prefix_cache_hit_tokens` | 0 | — |
| prefill per turn | ~0.85 s | — |
| decode per turn | ~0.06 s | — |
| **dialogue turn, end to end** | **984 ms** | **209 ms** |

*"NInfer decodes several times faster than vLLM on this box and still loses the turn by 4.7x,
entirely on prefill it did not need to redo."* Their prompt has a stable head and a volatile
tail (current time, sensor state), so it never becomes checkpoint-eligible. A third user
reports NInfer's end-to-end time being *"equal to or longer than Q6_K_L gguf in llama.cpp"*.

### And prefill throughput is a wash anyway

[#32](https://github.com/Neroued/ninfer/issues/32) compares published prefill against a vLLM
NVFP4 setup on the same card: **5,157 tok/s (NInfer @ 260,096) vs 5,124 tok/s (vLLM @
262,144) — 0.6% apart.** The maintainer confirms: *"Yes, attention is the bottleneck at long
context."* So NInfer's advantage is decode step rate and reuse, not prefill. Where reuse
fails, there is nothing left.

### What this does to the case

§4 projected +40% decode. These reports say decode speed is not what decides an agent's turn
— prefill is, and NInfer's reuse model is structurally mismatched to tool loops. Our sessions
are 20-40k tokens and growing; a 1-in-6 chance of a 30-second stall is worse than our current
uniform 10-second prefill, not better.

## 5. Packaging

Two paths. Do **not** start with the second one.

### Path A — reuse the podman plumbing (recommended for the spike)

`llama-swap.nix` already shells out to `podman run` on the host. The upstream `Dockerfile`
is a clean two-stage `nvidia/cuda:13.1.2-devel` → `runtime` build. Build it once on
redtruck, add a `ninferImage` next to `vllmImage`, and the only structural change is a
second `vllmArgs`-style flag list. Nothing else in `nixos.nix` or `container.nix` moves.
Upstream does not publish images yet ([issue #58](https://github.com/Neroued/ninfer/issues/58)),
so this is a local `podman build` — imperative, but so is the current image pin's
practical reality, and it's throwaway if the numbers disappoint.

### Path B — a real Nix derivation (only if Path A wins)

Genuinely tractable, because the dependency closure is tiny — CMake finds only
`CUDA::cudart`, `CUDA::cuda_driver`, `CUDA::nvtx3`, FFmpeg, libcurl and pthreads. **No
cuBLAS, no cuDNN, no NCCL, no PyTorch, no Python.** No `FetchContent`, no submodules; the
three third-party deps are vendored headers. Compare that to a 10+ GB vLLM OCI image.

`nixpkgs` unstable has `cudaPackages_13_1`, so the `>= 13.1` floor is met.

```nix
# modules/local-llm/ninfer.nix (sketch — not wired up)
{ lib, fetchFromGitHub, cmake, ninja, pkg-config, ffmpeg, curl, cudaPackages_13_1 }:
let cuda = cudaPackages_13_1;
in cuda.backendStdenv.mkDerivation {
  pname = "ninfer";
  version = "0-unstable-2026-08-30";

  src = fetchFromGitHub {
    owner = "Neroued";
    repo = "ninfer";
    rev = "<pin a commit — upstream cuts no releases>";
    hash = lib.fakeHash;
  };

  nativeBuildInputs = [ cmake ninja pkg-config cuda.cuda_nvcc ];
  buildInputs = [ ffmpeg curl cuda.cuda_cudart cuda.cuda_cccl ];

  cmakeFlags = [
    # CMakeLists.txt:9 FATAL_ERRORs on anything else.
    (lib.cmakeFeature "CMAKE_CUDA_ARCHITECTURES" "120a")
    (lib.cmakeBool "NINFER_BUILD_APPS" true)
    (lib.cmakeBool "BUILD_TESTING" false)
    (lib.cmakeBool "NINFER_BUILD_BENCHMARKS" false)
  ];

  # Upstream ships no install target: "run NInfer from its source build tree".
  installPhase = ''
    runHook preInstall
    install -Dm755 apps/ninfer apps/ninfer-serve apps/ninfer-perplexity -t $out/bin
    runHook postInstall
  '';

  passthru.cache = true;   # redtruck compiles once; the private cache serves it
  meta.license = lib.licenses.asl20;
}
```

The honest cost: `modules/nvidia/nixos.nix:41-44` currently celebrates that *"there is no
large CUDA compile here any more, and with it no need to clamp max-jobs."* Path B reverses
that. 100k lines of CUDA at a single arch, with `JOB_POOLS cuda_link=1` serialising links.

Weights would move from the `linkFarm` of ~11 `fetchurl`s to a single 20 GiB (or 17 GiB)
`fetchurl`. `weights.nix`'s comment about "partial download retries one shard" stops being
true — one blob, all or nothing.

## 6. Gain / lose

**Gain**

- Prefix reuse on a hybrid-attention model that vLLM refuses to prefix-cache. Potentially
  10-40 s off every deep pi turn. The main reason to try this.
- Sub-minute startup. `healthCheckTimeout: 900` and `ttl = null` exist because "vLLM cold
  start is minutes". A C++ mmap load makes model swapping viable again — `ttl` could come
  back, and re-enabling Qwen3.6 alongside 3.8 stops being a minutes-long stall.
- Deployment mass: a few hundred MB of closure vs a 10+ GB OCI image, and no Python.
- ~3 GiB more VRAM for KV if groupwise-int proves out, plus ~12% faster code decode.
- Vision is genuinely absent rather than clamped to zero, removing the startup-OOM class.
- Strict API surface: unsupported options 400 with a named code instead of being silently
  dropped. Painful once at migration, then honest forever.
- Per-request JSONL with `prefix_reuse_path`, `queue_wait_seconds` and MTP acceptance —
  strictly better observability than `/metrics` for diagnosing pi sessions.

**Lose**

- **Ecosystem.** A two-month-old single-maintainer project, no tagged releases, several
  maintainer docs in Chinese, pinned to one consumer GPU. vLLM is the fallback if this
  stalls, so `models.nix`'s vLLM tuning stays in tree either way.
- **No preemption.** Overcommit becomes queueing and eventually 503, not graceful
  degradation. `--pending-timeout-ms` must be tuned deliberately.
- **Hard-pinned to the 5090.** If redtruck's card ever changes, the engine is gone, not slow.
  (Also confirm the card really is a desktop 5090 — the laptop GB203 is broken, see
  [issue #39](https://github.com/Neroued/ninfer/issues/39).)
- **No constrained decoding**, no LoRA, no multi-GPU — permanent ceilings, not roadmap items.
- **A CUDA compile returns** under Path B, undoing a deliberate simplification.
- Per-request thinking budget regresses to a process-wide default.
- Bus factor: five registered checkpoints, hand-registered. When Qwen3.9 lands, vLLM has
  day-0 support and NInfer has an issue thread.

## 7. Vision — we already own these weights, we just can't use them

Correction to a common assumption: **`unsloth/Qwen3.8-27B-NVFP4` does contain the vision
tower.** Read straight off the safetensors header of the checkpoint `weights.nix` fetches:

| Tensor group | Bytes | |
|---|---:|---:|
| `model.language_model.*` | 20,374,585,728 | 18.97 GiB |
| `model.visual.*` | **921,460,192** | **0.86 GiB** |
| `lm_head` + in-file MTP | 1,271,895,040 | 1.18 GiB |
| `model.safetensors` total | 22,567,940,960 | 21.02 GiB |
| `+ model_mtp.safetensors` | 849,400,392 | 0.79 GiB |
| **On-disk total** | **23,417,341,352** | **21.81 GiB** |

333 `model.visual.*` entries are in `model.safetensors.index.json`. What makes us text-only
is our own serving config, not the checkpoint: `llama-swap.nix:41` passes
`--limit-mm-per-prompt '{"image":0,"video":0}'` because *the vision-encoder profiling buffers
OOM'd startup*. That flag is a request-level admission limit — it suppresses the multimodal
profiling run that OOM'd and rejects media requests. Worth confirming from `nvidia-smi`
whether vLLM still materialises the 0.86 GiB tower anyway, because if so we are paying for it
and getting nothing.

### What NInfer changes

Both Qwen3.8 artifacts embed a working Vision stack, and both were evaluated multimodally:

| Artifact | Size | ERQA | RealWorldQA |
|---|---:|---:|---:|
| `qwen3_8_27b_nvfp4.ninfer` | 20.02 GiB | 66.25% | 83.53% |
| `qwen3_8_27b.ninfer` (groupwise-int) | **16.96 GiB** | 66.25% | 82.22% |

Note where NInfer's vision comes from: the model card says the artifact "combines the
official BF16 checkpoint with the fixed packed Text weights from
`unsloth/Qwen3.8-27B-NVFP4`", and that "BF16 control weights and the registered MTP and
Vision allocations are retained". So the Text weights are ours, and the Vision tower is
Qwen's official BF16 — not unsloth's quantised copy.

The arithmetic that matters on a 31 GiB card:

| | Weights resident | vs. today |
|---|---:|---:|
| vLLM today (vision loaded, unusable) | 21.81 GiB | — |
| NInfer nvfp4 (vision usable) | 20.02 GiB | **+1.8 GiB free** |
| NInfer groupwise-int (vision usable) | 16.96 GiB | **+4.8 GiB free** |

So this is not "pay VRAM to gain vision". NInfer plausibly gives us working vision *and*
more room for KV than we have now. `--vision` does add a workspace extent beyond the
weights, which is unmeasured and is the thing to check.

### Vision token economics (corrected from the docs' wording)

`docs/serving.md:228-232` and `docs/cli.md:253` read as if a media-bearing prompt is capped
at 32,768 tokens total. The code says otherwise. From
`src/targets/qwen3_6/export/ninfer/targets/qwen3_6/prepared_prompt.h:20-29` and the check at
`impl/frontend/processor.cpp:636` (`stats.vision_tokens > options.max_vision_tokens`), the
cap is on **expanded vision tokens**, not on the whole prompt:

| Constant | Value | Meaning |
|---|---:|---|
| `kMaximumPromptVisionTokens` | 32,768 | aggregate vision tokens per prompt |
| `kMaximumVisionItemTokens` | 16,384 | vision tokens for one image/video item |
| `kRawPatchesPerVisionToken` | 4 | 2x2 merge over 16x16 patches -> one token per 32x32 px |
| `image_max_pixels` | 1,048,576 | images are resized down to ~1.05 MP |
| `video_max_pixels` / `video_max_frames` | 4,194,304 / 768 | video budget |

Consequences for an agent loop:

- **A screenshot costs ~1,024 vision tokens**, because a 1920x1080 frame (2.07 MP) is
  downscaled to the 1.05 MP ceiling first. Attaching one to a 40k-token coding session costs
  about 1k tokens and stays comfortably inside `--max-context 131072`. Text-only turns are
  unaffected by `--vision` entirely.
- Roughly 32 screenshots fit in one prompt before the aggregate cap bites. That is not the
  binding constraint.
- **The 1.05 MP resize is the binding constraint for UI work.** "Is the layout broken, is
  this button off-centre" survives the downscale. "Why is this 2px misaligned, why is this
  10px font clipped" probably does not.
- Prepared media is cached by SHA-256 of the fetched bytes (`--media-cache-mib` 1024,
  `--media-live-mib` 2048), and a prefix hit covering an image **skips Vision execution
  entirely** — re-sending a screenshot in a long thread is close to free.

### Vision is not a reason to adopt NInfer

We already own the vision weights (0.86 GiB of `model.visual.*`, table above) and vLLM
supports Qwen3-VL multimodal. The only thing switching it off is our own
`--limit-mm-per-prompt '{"image":0,"video":0}'`, added because the vision-encoder
**profiling** buffers OOM'd startup — profiling allocates for the maximum item count at
maximum resolution. vLLM v0.26.0's Qwen3-VL accepts `min_pixels`/`max_pixels` overrides
through `mm_processor_kwargs` (`vllm/model_executor/models/qwen3_vl.py:894-897`), so the
profiling allocation is directly tunable:

```
"--limit-mm-per-prompt '{\"image\":1,\"video\":0}'"
"--mm-processor-kwargs '{\"max_pixels\": 1048576}'"
```

That is the same shape of experiment as the prefix-caching flag in §4, and §4's log evidence
(KV usage 10-25%) says there is far more headroom now than when the OOM comment was written.
**Try this before treating vision as a migration driver.**

### What vision is actually worth for frontend/game work

Honest scoping, because the published numbers do not answer the question:

- The evals are **ERQA (66.25%) and RealWorldQA (83.53%)** — embodied reasoning and
  photographs of physical scenes. Screenshot and UI comprehension is ScreenSpot /
  VisualWebBench / OSWorld territory, and **neither NInfer nor the Qwen3.8 model card
  publishes any of those**. We would be adopting on an unmeasured capability.
- Render -> screenshot -> critique -> iterate is a genuinely useful loop for CSS and layout
  bugs that are invisible in the source. That part is real.
- Games are motion. A static frame catches render and layout bugs, not physics, timing, or
  feel. Video input exists but 768 frames at a ~4 MP budget is a short low-resolution clip,
  and gameplay reasoning from sampled frames is far outside anything benchmarked here.
- **We have no screenshot tool.** `modules/devbox/plugins.nix` seeds `superpowers`,
  `@teelicht/pi-superagents` and `pi-web-access`; the last is exa-backed search and fetch,
  which is text. Nothing in that set drives a browser or captures a framebuffer. pi's model
  schema does carry `input: ["text","image"]` (`dist/core/model-config.js:141`), so the
  provider side is a one-line change — but the tooling side is the real work, and it is
  entirely independent of which engine serves the model.

## 8. Subagent batching

This is the other reason to care, and the honest answer is that NInfer's two published
concurrency campaigns disagree, because they measure different things.

**Campaign A — synthetic decode saturation.** 293-token prompts, 8,192-token outputs,
`--kv-capacity auto` resolving to exactly `C * 16,384`. This is the README's headline table:

| C | Aggregate decode tok/s | Speedup |
|---:|---:|---:|
| 1 | 143.8 | 1.00x |
| 2 | 267.6 | 1.86x |
| 4 | 461.1 | 3.21x |
| 8 | 766.6 | **5.33x** |

**Campaign B — fixed 75-request mixed corpus**, 131,072-token ceiling, `--kv-capacity auto`,
prefix reuse disabled, C persistent workers each submitting the next request on response.
This is much closer to a subagent wave:

| C | Makespan (s) | Decode tok/s | Avg batch | Speedup |
|---:|---:|---:|---:|---:|
| 1 | 4,670 | 161.1 | 1.00 | 1.00x |
| 2 | 2,511 | 294.7 | 1.98 | 1.86x |
| 4 | **1,648** | 432.9 | 3.29 | **2.83x** |
| 8 | 2,165 | 334.2 | 2.36 | 2.16x |

**C=4 is the sweet spot; C=8 is slower than C=4** because memory pressure collapses the
achieved batch (2.36 against a configured 8). Take 2.83x, not 5.33x, as the number to beat.
We currently run `maxNumSeqs = 3`, so the real question is whether NInfer at C=3-4 beats
vLLM at C=3 — which nobody has measured, ours or upstream's.

### Three structural differences that decide it

**1. Admission reserves the full output budget upfront.** From the TTFT bench, for a request
with `p` prompt tokens and output limit `o`:

```text
e = 64 * ceil((p + o - 1) / 64)
```

The request holds `e` pages from admission to completion, whether or not it generates that
many tokens. vLLM allocates opportunistically and preempts under pressure; NInfer refuses to
admit until a legal plan exists. **This is more conservative, and it can make effective
concurrency lower on NInfer than on vLLM for the same pool**, even with more configured
lanes. A subagent declaring `maxTokens = 8192` reserves 8,192 pages even if it answers in
400 tokens.

That reframes `models.nix:24-40`. Today's reasoning is "3 x (48k alias window + 8k output)
≈ 168k of the pool, and vLLM preempts if we transiently overcommit." On NInfer nothing is
transient — the fourth request simply waits. Concretely: a main session at 120k prompt +
32,768 output reserves ~153k pages by itself, so two subagents at ~28k each already push
past a 203k-equivalent pool. The lever is pi's declared `maxTokens`, which becomes a
*reservation* rather than a ceiling, and is worth lowering on the alias.

**2. Prefills serialise; they do not co-batch with decode.** The scheduler guarantees at most
one staged-prefill request at a time, and a worker boundary runs *at most one* model
execution unit — so a round is a prefill chunk **or** a decode batch, never a mix
(`docs/maintainer/engine-architecture.md` §5.3). Our vLLM runs chunked prefill with
`--max-num-batched-tokens 2048`, which folds prefill tokens into the same forward pass as
decode. Same total FLOPs either way; different latency distribution. There is an explicit
fairness gate so decode is not starved by continuous prefill, but a fan-out of four subagents
with 20k prompts each will see their TTFTs stack rather than progress together.

**3. Exact-batch CUDA Graph decode.** Batches use exact `B` with no padding to
`max_concurrency`, with a captured graph per batch size. A wave that drops from 4 lanes to 1
gets a genuine single-row graph rather than a padded 4-row step. That is a real advantage
over vLLM at *ragged* concurrency, which is exactly what subagent fan-out looks like as
subagents finish at different times.

### Where prefix reuse and batching multiply

Campaign B ran with **prefix reuse disabled**. Our subagent tiers all share one system prompt
and one served instance, so `shared_stable_prefix` is directly applicable — but
`--max-shared-prefixes` defaults to `max-concurrency` and `--max-private-continuations` to
`2 * max-concurrency`, so a 4-lane fan-out with a main session in flight will want these
raised explicitly. This combination — several lanes sharing a prefix, each resuming its own
continuation across turns — is the case with the most headroom and the least published
evidence.

### Suggested starting profile for the C=4 test

```text
--max-concurrency 4
--max-context 131072
--kv-capacity auto
--kv-dtype fp8
--spec mtp --draft-tokens 3 --lm-head-draft
--pending-timeout-ms 600000       # NOT the 30s default; a busy lane holds ~55s
--max-pending-requests 16
--device-state-slots 4
--host-state-slots 8
--host-kv-mib 16384
--max-shared-prefixes 8           # default would be 4
--max-private-continuations 16    # default would be 8
--request-log-jsonl /var/log/ninfer.jsonl
```

## 9. Recommendation

**Don't migrate.** The field reports in §4b are from our exact workload — a tool-calling
coding agent on Qwen3.8-27B NVFP4 — and independently conclude NInfer is a no-go for it. Its
checkpoint model anchors on human turns, our subagents spend 50+ round trips between human
turns, and the documented consequence is a 1-in-6 chance of a 30-second stall. That is worse
than the uniform ~10 s prefill we have now, and the +40% decode advantage from §4 does not
buy it back.

**Do the two vLLM flags instead.** Both of NInfer's remaining selling points turn out to be
things our existing engine can do and we have switched off:

1. **Prefix caching** (§4). `--enable-prefix-caching --mamba-cache-mode align`. Hybrid
   support is present in v0.26.0 and merely opt-in; align mode has been the spec-decoding
   default since 2026-04-21. This targets `Prefix cache hit rate: 0.0%`, the biggest number
   in our logs, and vLLM's LCP matching has no checkpoint-eligibility cliff. Watch the
   `block_size <= max_num_batched_tokens` assert (we pass 2048) and re-test for the
   incoherent-rewrite behaviour recorded at `models.nix:157`.
2. **Vision** (§7). `--limit-mm-per-prompt '{"image":1,"video":0}'` plus
   `--mm-processor-kwargs '{"max_pixels": 1048576}'`. We already own the 0.86 GiB vision
   tower; the profiling OOM that made us set `image:0` is directly tunable, and §4's logs
   show KV at 10-25% so the headroom exists now.

Both are `llama-swap.nix` edits, no download, no new dependency, no CUDA compile, no pi
config change. Do them in separate commits so a regression is attributable.

**Then, if vision works, the real work is a screenshot tool**, and it is engine-independent.
pi already accepts images from tool results
(`dist/utils/tool-result-images.js`) and from `read` on an image file, so the cheapest path
needs no plugin at all: add a headless browser to `modules/devbox/container.nix` and let the
agent screenshot to a PNG and `read` it. See §7.

**Revisit NInfer when** [#62](https://github.com/Neroued/ninfer/issues/62) closes with a
rolling in-tool-loop checkpoint or client-declared boundaries. The engine is genuinely fast
— 59 decode rounds/s against our 41.8, and 270-300 ms TTFT on its good path — and the
maintainer is responsive. The reuse model is the blocker, it is a known and actively
discussed one, and it is the only thing standing between this and a real upgrade.

Also worth confirming if that day comes: that redtruck's card is a **desktop** 5090 and not
the laptop GB203, which is broken upstream
([issue #39](https://github.com/Neroued/ninfer/issues/39)).
