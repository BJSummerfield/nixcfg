# Qwen3.8-27B Settings for Agentic Coding — Findings

**Date:** 2026-08-30
**Scope:** `modules/local-llm/{models,llama-swap}.nix` and `modules/pi-coding-agent/settings.nix`
on the current stack (vLLM v0.26.0, `unsloth/Qwen3.8-27B-NVFP4`, pi 0.84.2).
**Status:** research; no config changed yet. Companion to
`2026-08-30-ninfer-spike.md`, which concluded "don't migrate, fix the vLLM config."

Qwen3.8-27B released **August 2026** — this month. Most of what follows is a consequence of
that: the model does things (tool calls opened inside `<think>`, a template-level effort
switch) that the surrounding tooling has not fully caught up with.

## 1. Sampling — already correct, and leave it alone

The official card's thinking-mode block is `temperature=1.0, top_p=0.95, top_k=20,
min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0`. `models.nix` `sampling` matches
exactly. Non-thinking mode would be `0.7 / 0.80 / 20 / 0 / 1.5`, which we never use.

Do **not** lower temperature "for precise coding". 1.0 is the specified thinking-mode value;
deviating from Qwen's thinking-mode sampling is a documented cause of degradation and
repetition.

One stale comment to clean up, `llama-swap.nix:52-54`:

```nix
# the repo's generation_config ships 1.0; pi is a coding agent, so pin the
# precise-coding value instead
"--override-generation-config '{\"temperature\": ${num m.sampling.temperature}}'"
```

That was written for 3.6, where `sampling.temperature = 0.6` genuinely differed from the
repo's 1.0. For 3.8 the catalog value **is** 1.0 and `generation_config.json` ships
`temperature: 1.0`, so the override is now a no-op with a comment that says the opposite.

## 2. The chat template sets the prefix-caching rules

This is the important section. Read from `chat_template.jinja` in the unsloth repo.

### 2a. `reasoning_effort` is rendered into the first system block

```jinja
{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
{%- if resolved_reasoning_effort == 'high' %}{%- set resolved_reasoning_effort = 'xhigh' %}
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
    {{- raise_exception('Unexpected reasoning effort ...') }}
{%- if resolved_reasoning_effort == 'xhigh' %}
    {%- set reasoning_instructions = 'Reasoning effort is set to xhigh. Please think carefully ...' %}
```

`reasoning_instructions` is then emitted as the **first line of the first system message**,
immediately before the `# Tools` block. Two consequences:

- **Changing effort mid-session invalidates 100% of the prefix cache.** It changes token ~10.
  `settings.nix:130-133` already reasons about this correctly ("Each subagent session holds
  one constant level"). Worth promoting to a hard rule: the pi TUI's thinking-level toggle is
  a cache bomb, not a knob.
- **Changing the tool set invalidates 100% of the prefix cache**, for the same reason — the
  serialized `<tools>` array lives in that same first system block. A plugin that registers
  tools partway through a session pays for the whole conversation.

Note also that the template *raises* on any effort outside `xhigh|medium|low` (it maps
`high` -> `xhigh` itself). `models.nix` `thinkingLevels` already maps every pi level onto an
accepted value, so this is handled.

### 2b. `preserve_thinking` defaults to **true**, and that is what we want

```jinja
{%- if preserve_thinking is undefined or preserve_thinking is true or loop.index0 > ns.last_query_index %}
    {{- '<|im_start|>' + message.role + '\n<think>\n' + reasoning_content + '\n</think>\n\n' + content }}
```

pi replays prior reasoning back as `reasoning_content` when the server emits it
(`openai-completions.ts:1170-1176` sets `assistantMsg[signature]`, and the streaming parser
sets `signature = "reasoning_content"` for a `--reasoning-parser qwen3` server). We send no
`preserve_thinking`, so it is undefined, so it is **true**.

The tempting "optimization" is to set it false to shrink prompts. **Do not.** With `false`,
reasoning is retained only for messages after `last_query_index` — the last real
*human* turn, skipping `<tool_response>`. So every time a human speaks, the template
retroactively strips reasoning from all earlier assistant turns. That rewrites the middle of
the prompt and invalidates the prefix cache from the first dropped block onward.

With `true`, the prompt is strictly **append-only**, which is precisely the property prefix
caching needs. It costs prompt length; it buys every turn after the first.

(This is the same class of problem the NInfer field reports hit from the other direction —
see `2026-08-30-ninfer-spike.md` §4b, where a "volatile tail" made a prompt permanently
cache-ineligible. It is also why NInfer's own recommended server command passes
`--preserve-thinking`.)

## 3. `thinking_token_budget` should probably be turned off

`settings.nix:98` sets `supportsThinkingTokenBudget = true`, so pi sends a top-level
`thinking_token_budget` on every request: `min(budgets[level], maxTokens - 1024)`
(`MIN_ANSWER_TOKENS = 1024`). For us that is **16,384** on the main model at xhigh and
**7,168** on the 48k alias at medium.

Two open vLLM bugs make this risky on exactly our parser combination:

- [vllm#44676](https://github.com/vllm-project/vllm/issues/44676) (open, filed 2026-06-05) —
  `--tool-call-parser qwen3_coder` + `--reasoning-parser qwen3`. **Qwen3.5+ models open tool
  calls inside the `<think>` block without closing it first.** `Qwen3ReasoningParser` knows
  this and treats `<tool_call>` as an implicit reasoning end;
  `ThinkingBudgetStateHolder` does not, and keeps counting tool-call argument tokens against
  the thinking budget. When it runs out mid-JSON it force-injects `</think>` via logit
  masking **into the middle of the tool arguments**, and the model then re-emits a fresh
  `<tool_call>` nested inside the previous call's argument string.
  Reporter's differential: *small budget → 3 of 4 runs corrupted; large budget → 0 of 8;
  thinking off → 0 of 12.* A commenter adds: *"With qwen 3.8 this seems even more relevant
  since we need to reduce the thinking."*
- [vllm#39697](https://github.com/vllm-project/vllm/issues/39697) (open) — Qwen3.5
  `thinking_token_budget` causes `reasoning_end_str` to leak into the `content` field.

Our budgets are mid-sized rather than tiny, so we are not in the worst bucket, but the 7,168
on the alias is well within reach of one large file-write tool call.

**Recommendation:** set `supportsThinkingTokenBudget = false` and control thinking length
through `reasoning_effort` instead — `medium` shortens reasoning by *prompting*, which
cannot corrupt a tool call, rather than by logit forcing, which demonstrably can.

## 4. Prefix caching and prefill

From `2026-08-30-ninfer-spike.md` §4: `--enable-prefix-caching --mamba-cache-mode align`.
Hybrid models are supported in v0.26.0 and merely opt-in
(`vllm/engine/arg_utils.py:2518-2523`).

`--max-num-batched-tokens` is currently **2048** and should probably rise:

- `align` mode asserts `block_size <= max_num_batched_tokens`
  (`vllm/config/vllm.py:2265-2271`), and vLLM raises the attention block size to cover the
  mamba page size. Watch the startup line *"Setting attention block size to N tokens"* and
  make sure the flag is at least `N`.
- Independently, our own logs show prefill dominating a turn (20k and 40k prompt tokens
  inside single 10-second windows). A larger prefill batch is a direct win there, at the cost
  of some decode-latency jitter — which barely matters on a single-user box.

## 5. Speculative decoding: try 4

Measured per-position acceptance from the live server, `num_speculative_tokens: 3`:

| Sample | pos 1 | pos 2 | pos 3 | Mean accept len |
|---|---:|---:|---:|---:|
| good | 1.000 | 0.995 | 0.988 | 3.98 |
| typical | 0.957 | 0.902 | 0.852 | 3.71 |
| weaker | 0.872 | 0.744 | 0.631 | 3.25 |

Position 3 still accepting 85-99% on typical coding output means the draft is not exhausted
at depth 3 — there is headroom for `num_speculative_tokens: 4`. A/B it and compare mean
acceptance length, not acceptance *rate*: raising depth always lowers the rate while raising
throughput (NInfer's [issue #119](https://github.com/Neroued/ninfer/issues/119) shows the
same inversion — MTP3 was fastest despite the worst acceptance rate).

Do not jump straight to 5. NInfer [#92](https://github.com/Neroued/ninfer/issues/92) reports
Qwen3.8 at MTP5 entering repeated-token loops, and vLLM
[#52673](https://github.com/vllm-project/vllm/issues/52673) is an open RFC for a
spec-decode-aware reasoning loop breaker. Move one step and watch for repetition.

## 6. Effort levels: keep the current map

Card guidance is `xhigh` (default, complex tasks), `medium` (balanced), `low` (speed). Our
map — medium as the floor for every pi level, xhigh for high/xhigh/max — matches both the
card's agentic warning and `models.nix:57-64`'s own finding that low effort costs more in
retries than it saves per turn. No change.

## 7. Context

Card: native 262,144, extensible to 1M with YaRN (factor 4.0). For agentic tasks it suggests
budgeting reasoning up to 262k and final response up to 131k — far beyond a 31 GiB card.
`maxModelLen = 131072` / `maxTokens = 32768` stays the right compromise. Enabling prefix
caching raises steady-state KV pressure because cached blocks are retained; current usage is
10-25%, so there is room, but watch it.

## Suggested order

1. `--enable-prefix-caching --mamba-cache-mode align`, raising `--max-num-batched-tokens` to
   whatever the startup log's block size requires. Confirm hit rate leaves 0.0%.
2. `supportsThinkingTokenBudget = false` in `settings.nix`.
3. Delete the stale `--override-generation-config` comment (or the flag).
4. A/B `speculativeTokens = 4`.
5. Vision, separately (`2026-08-30-ninfer-spike.md` §7).

One commit each, so a regression is attributable.

## 8. Getting utilization out of one GPU

### First, the correct diagnosis

From the 2026-08-30 13:20-13:21 capture: `GPU KV cache usage: 10.3% - 24.8%`, and
`Running: 1 reqs, Waiting: 0` in **every** interval. The measured pool is 203,579 tokens
(`models.nix:29-31`).

We are not KV-limited and not batch-limited. We are **demand-limited** — the GPU spends the
session decoding one sequence. No server-side tuning changes that; only sending more
concurrent work does.

### The physics: on decode, batching is nearly free

A 27B decode step is bound by reading weights, not by arithmetic. Weights are 21.81 GiB
(23.4 GB); an RTX 5090 has ~1,792 GB/s (512-bit GDDR7 @ 28 Gbps), so the floor for one
forward pass is **~13 ms**. Our measured MTP round is **~24 ms** (41.8 rounds/s), so we are
at roughly half of peak bandwidth — normal for a hybrid model with GDN state reads.

The important part: a round decoding *four* sequences reads those same weights **once**.
Aggregate throughput scales close to linearly until arithmetic or KV becomes the limit.
NInfer's own corpus campaign measured exactly this shape — C=1 -> C=4 gave 2.83x makespan
and 3.29 average batch — before memory pressure broke it at C=8.

Every decode round we spend at `Running: 1` throws away roughly three quarters of what the
card can deliver, and no amount of KV headroom recovers it.

### Correction to a common framing

It is natural to assume NInfer "adapts KV per request" and vLLM is the rigid one. It is the
other way round:

| | vLLM | NInfer |
|---|---|---|
| KV pool | sized at startup | sized at startup (`--kv-capacity`, or `auto`) |
| Per-request allocation | blocks allocated **on demand** as tokens are produced | **full `prompt + output` entitlement reserved at admission** |
| Overcommit | preempt and recompute | refuse admission, queue FIFO, then 503 |
| Shared prefixes | deduplicated blocks across sequences | shared-prefix checkpoints, capped by `--max-shared-prefixes` |

NInfer's genuine additions are startup `auto` sizing and spilling retained prefixes to pinned
host RAM. Its admission model is *more* conservative than vLLM's, not more adaptive — a
subagent that declares `maxTokens = 8192` holds 8,192 pages even if it answers in 400
tokens. For "many concurrent requests of unknown length", vLLM's on-demand allocation is the
better fit, which is the same conclusion §4b reached from the reuse angle.

### Lever 1 (largest): prefix caching stops charging us N times for the shared prefix

This is the part that changes the capacity arithmetic, not just the latency.

`models.nix:24-40` sizes the 48k alias from a worst case of `3 x (48k alias window + 8k
output) ~= 168k` against a 203k pool. That arithmetic assumes each subagent's tokens are
distinct. They are not — parallel subagents share a system prompt, a tool list, and usually a
large slab of repo context. With `--enable-prefix-caching`, vLLM stores those blocks **once**
and every sequence referencing them adds nothing.

So enabling prefix caching does three things at once:

1. removes the re-prefill cost (the `0.0%` hit rate);
2. raises effective concurrency for free, because the shared head stops multiplying;
3. makes the 48k alias's deliberately tight window less necessary — it exists to stop a
   fan-out wave thrashing a pool that was being charged N times for the same tokens.

Re-measure `GPU KV cache usage` after enabling it before touching anything else. Expect it to
*rise* — retained cache blocks are a good use of idle KV, not a problem.

### Lever 2: create actual concurrency

Server tuning is downstream of this. Sources of parallel demand we already have or could:

- **pi-superagents fan-out.** Every tier already points at the same instance so nothing swaps
  (`settings.nix:120-145`). Worth confirming from the vLLM log that a fan-out actually
  produces `Running: 3` — the captured trace never left `Running: 1`, so either no fan-out
  ran in that window or subagents are being dispatched serially. That is the single most
  valuable thing to check, because everything below assumes it works.
- **Both agent containers.** `devbox` and `workbox` each run an agent; if both point at
  redtruck they generate natural overlap.
- **Open WebUI** already shares the instance.
- **Queued background work** — review sweeps, test generation, overnight batch. Latency does
  not matter for these, and they fill lanes that would otherwise idle.

### Lever 3: raise the caps, but only after 1 and 2

- `--max-num-seqs`: currently 3. With a 203k pool and a realistic ~20-25k of *actual*
  in-flight tokens per sequence, 6-8 is affordable — and more once prefix caching dedupes
  the shared head. Raise it after measuring, not before.
- `--max-num-batched-tokens`: currently 2048, see §4. Raising it is required for `align` mode
  and directly speeds the prefill that dominates our turns.
- `--gpu-memory-utilization`: already 0.94. Leave it. At 10-25% pool usage, squeezing another
  1-2% of VRAM solves a problem we do not have.
- `--max-model-len`: 131072 against a 262144 native. Raising it does not consume KV by itself,
  but longer contexts cost attention time and KV per request. Not a utilization lever.

### What not to do

- Do not serve a second model. Weights are 21.81 GiB of 31 GiB; two will not fit, and
  llama-swap tearing down a vLLM instance costs minutes (`models.nix:71`).
- Do not raise `--max-num-seqs` to chase a number while `Running: 1`. It is a ceiling, not a
  generator.
- Do not lower temperature or effort to "fit more" — see §1 and §6.

### What to watch

`Running:` (is concurrency real), `GPU KV cache usage` (is the pool finally working),
`Prefix cache hit rate` (is it leaving 0.0%), and `Avg generation throughput` **specifically
at `Running > 1`** — that last one is the number that tells us whether batching is paying,
and none of the captured intervals contain it.

## 9. Vision: root cause of the startup OOM, and the fix

We already own the vision tower — 921,460,192 bytes (0.86 GiB) of `model.visual.*` across
333 entries in `model.safetensors.index.json`. `llama-swap.nix:40-41` turns it off:

```nix
# served text-only: weights alone are ~22GiB of a 31GiB card, and the
# vision-encoder profiling buffers OOMed startup
"--limit-mm-per-prompt '{\"image\":0,\"video\":0}'"
```

### Why it OOM'd

`preprocessor_config.json` in the unsloth repo:

```json
"size": { "longest_edge": 16777216, "shortest_edge": 65536 },
"patch_size": 16, "temporal_patch_size": 2, "merge_size": 2
```

`longest_edge` is the default `max_pixels`: **16,777,216 px — 16.78 megapixels.** With a
16x16 patch and 2x2 merge, one vision token covers 32x32 px, so the default admits
**16,384 vision tokens for a single image**. vLLM's memory profiling builds a dummy input at
that maximum and runs the encoder on it. With ~9 GiB free after 21.81 GiB of weights, that
OOMs. The comment blamed the card size; the actual cause is a 16.78 MP default nobody needs.

### The fix

```nix
"--limit-mm-per-prompt '{\"image\":1,\"video\":0}'"
"--mm-processor-kwargs '{\"max_pixels\": 1048576}'"
"--mm-processor-cache-gb 1"
```

- `max_pixels: 1048576` (1 MP) is a **16x smaller** profiling shape — 1,024 vision tokens
  instead of 16,384. vLLM v0.26.0's Qwen3-VL reads this override at
  `vllm/model_executor/models/qwen3_vl.py:894-897` and maps it onto
  `size.longest_edge`. Corroboration that 1 MP is the right number for this model on this
  card: it is exactly the `image_max_pixels` default NInfer's author chose
  (`src/targets/qwen3_6/impl/frontend/processor.h:84`).
- `mm_processor_cache_gb` defaults to **4 GiB and is duplicated per API and engine process**
  (`vllm/config/multimodal.py:123-131`), so up to ~8 GiB of host RAM for a cache of processed
  images we will rarely reuse. Cap it.
- `video:0` stays: the video default is `longest_edge: 25165824` (24 MP), and we have no
  video use case.

If it still OOMs, `--skip-mm-profiling` (`vllm/config/multimodal.py:183-189`) omits the
multimodal profiling pass entirely, at the cost of making peak encoder memory our problem
rather than vLLM's — pair it with a small drop in `--gpu-memory-utilization`.

### Cost at steady state

A 1920x1080 screenshot is 2.07 MP, downscaled to the 1 MP cap, so **~1,024 tokens per
screenshot** in the prompt. Negligible against a 131,072 window. The encoder weights are
already resident whether we use them or not.

**But note the ordering problem:** enabling vision is only worth doing alongside a tool that
produces images. See `2026-08-30-ninfer-spike.md` §7 — nothing in
`modules/devbox/plugins.nix` drives a browser or captures a framebuffer, and pi already
accepts images from `read` on a PNG, so the cheapest path is adding a headless browser to
`modules/devbox/container.nix` rather than any plugin.

## 10. Do we still need llama-swap?

Short answer: **the fan-out context limits do not come from llama-swap, so nothing about
dropping it threatens them.**

### Where the context limits actually live

`pi-coding-agent/settings.nix` `mkAlias` builds a pi model entry:

```nix
{ inherit id; name = a.displayName; reasoning = m.reasoning;
  contextWindow = a.contextWindow; maxTokens = a.maxTokens; }
```

`contextWindow` drives **pi's** compaction threshold; `maxTokens` becomes the request's
`max_tokens`. Both are enforced entirely client-side. llama-swap's only contribution is the
`aliases:` + `useModelName:` pair, which rewrites the `model` field back to the served name
before forwarding. It never sees or applies a window.

### The one-line replacement

`served_model_name` is `str | list[str]` and *"if multiple names are provided, the server will
respond to any of the provided names"* (`vllm/config/model.py:265-272`). So:

```
--served-model-name Qwen3.8-27B-NVFP4 Qwen3.8-27B-NVFP4-48k
```

vLLM then answers to both IDs against one resident instance, and pi's two entries keep their
different declared windows exactly as today.

### What we would actually lose

| llama-swap feature | Current use |
|---|---|
| model swapping | **none** — `enabled = [ "Qwen3.8-27B-NVFP4" ]`, one model |
| `ttl` unloading | **none** — `ttl = null` |
| `healthCheckTimeout: 900` | holds requests during the multi-minute cold start; without it, requests during load get connection-refused and pi errors once |
| process lifecycle | starting/stopping the podman container — replaceable with a systemd unit |

### What we would have to rebuild

Today llama-swap runs *inside* the nspawn container and drives podman on the host over the
bind-mounted socket, and the container is the network entry point
(`tailscale serve --bg --https=8443 8081`). Removing it means something else must start the
vLLM container and present it on 8081 inside the container. Workable — a host systemd unit
plus `tailscale serve --bg --https=8443 http://192.168.100.24:5800`, and Open WebUI's
`OPENAI_API_BASE_URL` moves off `127.0.0.1:8081` — but it is real surgery on
`modules/local-llm/nixos.nix` and `container.nix`.

### Recommendation

**Keep it.** It is a Go reverse proxy on a local veth; the latency is sub-millisecond and it
costs no VRAM. Removing it buys nothing for "getting more out of the hardware" and spends a
day on plumbing. Remove it later if we want the simplification for its own sake — that is a
legitimate reason, just not a performance one.

One caveat worth ruling out empirically, given §8's `Running: 1` mystery: llama-swap's README
documents no concurrency limit and it should forward requests in parallel, but it *is* in the
path. If a known fan-out still shows `Running: 1` in the vLLM log, bypass llama-swap for one
test by pointing pi straight at `http://192.168.100.24:5800/v1` before concluding the problem
is in pi.

## 11. Context tiers: can the model manage its own budget?

**No, and it is not close.** Three independent reasons:

1. `contextWindow` is a **pi scheduler input**, not a model-visible value.
   `dist/core/compaction/compaction.js:160-163`:
   ```js
   export function shouldCompact(contextTokens, contextWindow, settings) {
       return contextTokens > contextWindow - settings.reserveTokens;   // reserveTokens: 16384
   }
   ```
   The model cannot trigger, defer, or observe compaction. It happens to it.
2. `maxTokens` is a request field pi sets *before* the model runs.
3. Models are unreliable at self-estimating token counts — it is close to the worst thing to
   delegate to one.

And there is a fourth reason specific to this model: per §2a, **anything added to the system
prompt to instruct the model becomes part of the cached prefix**. "Tell the model to manage
its context" would be both ineffective *and* charged against every request forever.

Prompting still has a legitimate role — "be concise", "grep before reading whole files"
reduces context growth at the source. But it is not a substitute for a declared window, and
it should go in agent frontmatter, not the shared system block.

So: **actual model entries.** That is the right design, not a limitation. A compaction
threshold is scheduler policy, and scheduler policy should be declarative.

### The counterintuitive part: prefix caching inverts the tiering argument

The 48k alias exists (`models.nix:24-40`) to stop a fan-out wave exhausting KV:
`3 x (48k + 8k) ~= 168k` of a 203k pool. Prefix caching removes most of that pressure — the
shared system prompt, tool list and repo context are stored **once** instead of three times.

Meanwhile compaction becomes the *most expensive event in a session*. Look at what one costs:

- a full prefill of the history being summarized (the summarization call uses its own
  `customInstructions`, so it will not hit the conversation's cached prefix);
- a summary generation, capped at `min(0.8 * reserveTokens, model.maxTokens)` = up to
  **13,107 tokens** (`compaction.js:461`);
- a re-prefill of the new compacted context on the next turn, because the summary replaces
  history and invalidates the cache from the first summarized message onward.

Rough cost at our measured rates (~3,500 tok/s prefill at depth, ~150 tok/s decode): a
compaction at a 32,768-token threshold is on the order of **25-40 seconds**. That is worse
than the prefill we are trying to eliminate.

So once prefix caching is on, the goal is not "compact more cheaply" — it is **push the
compaction threshold above the natural size of the task so it never fires.** A subagent whose
work naturally lands at 45k tokens costs one 30-second compaction at the current alias
(threshold 32,768) and **zero** at a 81,920 window (threshold 65,536).

**Prefix caching argues for bigger windows, not smaller — the opposite of what the alias was
designed for.**

### On "100k windows with parallel two"

That works, and it is cheaper than it looks: **a declared window is a compaction trigger, not
an allocation.** vLLM allocates blocks on demand, so declaring 110k costs nothing until a
session actually grows there. (This is exactly the property NInfer does *not* have — see
§8's table; there the declared budget is reserved at admission.)

Our measured KV usage is 10-25% of a 203k pool, so real in-flight tokens are nowhere near the
declared windows today.

### Suggested tiers — two, not four

A tier is only useful if a distinct *population* of sessions uses it; a session is bound to
one model entry for its life and cannot move between them. We have two real populations
(`settings.nix:120-145`): the main session plus `sp-review`/`sp-debug` on `max`, and the
parallel `sp-recon`/`sp-research`/`sp-implementer` fan-out on `cheap`.

| Entry | contextWindow | Compacts at | maxTokens | Population |
|---|---:|---:|---:|---|
| `Qwen3.8-27B-NVFP4` | 110,592 (unchanged) | 94,208 | 32,768 | main session, `max` tier |
| `Qwen3.8-27B-NVFP4-80k` | 81,920 (was 49,152) | 65,536 | 8,192 | `cheap` fan-out |

Raising the fan-out alias from 48k to 80k roughly doubles the working room before compaction,
which for most subagent tasks means never reaching it. `maxTokens` stays at 8,192 — under
vLLM that is a pure ceiling on rambling, not a reservation, so it costs nothing to keep tight.

A third "quarters" tier is not obviously worth it. There is no third population to give it
to, and if a runaway subagent is the worry, the lever is `maxTokens` and agent frontmatter,
not another window.

### What the "rate of decay" actually is

Worth naming precisely, because it changes which lever matters. From upstream's Qwen3.8-27B
NVFP4 profile at MTP0:

| Prompt tokens | Decode tok/s | Prefill tok/s | TTFT |
|---:|---:|---:|---:|
| 7,680 | 71.2 | 8,340 | 0.93 s |
| 64,512 | 65.7 | 5,298 | 12.3 s |
| 130,048 | 59.6 | 3,545 | 36.9 s |
| 260,096 | 52.9 | 2,203 | 118.4 s |

**Decode decays ~16% from 7.7k to 130k.** That is the part context tiering could address, and
it is small. **Prefill decays 2.4x and TTFT 40x.** That is what a long session actually feels
like — and prefix caching removes it for the unchanged prefix, while tiering barely touches
it.

Order of leverage for "faster agentic coding on one box", largest first:

1. prefix caching (§4) — removes per-turn re-prefill entirely
2. avoiding compaction (this section) — removes 25-40 s events
3. real concurrency (§8) — uses the idle three-quarters of the card
4. context tiering as a *decode* optimization — ~16%, last

## 12. Two sessions both fanning out — what actually happens

### How much load the client can generate

`@teelicht/pi-superagents` hardcodes its fan-out limits:

| Constant | Value | File |
|---|---:|---|
| `MAX_CONCURRENCY` | 4 | `src/shared/types.ts:480` |
| `MAX_PARALLEL` | 8 | `src/shared/types.ts:479` |
| `MAX_PARALLEL_CONCURRENCY` | 4 | `src/execution/parallel-utils.ts:106` |
| `DEFAULT_SUBAGENT_MAX_DEPTH` | 2 | `src/shared/types.ts:481` |

None are exposed in `default-config.json`, so **a fan-out is 4-wide per session, up to 8
tasks**, and depth 2 means a subagent can itself fan out. Two sessions both fanning out is
therefore `2 mains + 8 subagents = 10 in-flight requests`, with a tail risk of more at depth 2.

Against `--max-num-seqs 3`.

### What vLLM does with the other seven

They **queue**. vLLM admits up to `max_num_seqs` and the rest sit in the waiting queue —
`Running: 3 reqs, Waiting: 7 reqs` in the log line we already watch. Nothing errors, nothing
is rejected, and no work is lost.

Two things make this safe rather than merely tolerable:

- **pi sets no default request timeout.** `timeoutMs` is optional and only applied when
  explicitly provided (`openai-completions.ts:244`), so a request waiting in vLLM's queue
  simply waits. There is no spurious-failure cliff to design around.
- **KV cannot overflow at `max_num_seqs 3`** — the sequence cap is doing the protecting. If
  we raise it and the running set does outgrow KV, vLLM **preempts and recomputes**, and with
  prefix caching on the recompute is cheap because the evicted sequence's blocks are often
  still cached. This is exactly the graceful degradation NInfer lacks (§8's table: it refuses
  admission and eventually 503s).

So the answer to "what happens" is: **it queues, and that is correct.** The failure mode is
latency, not errors.

### The part worth internalising: concurrency does not create capacity

Batching fills idle lanes on a bandwidth-bound decode (§8), but the returns stop early.
NInfer's own mixed-corpus campaign on this exact model and card:

| C | Makespan | Speedup |
|---:|---:|---:|
| 1 | 4,670 s | 1.00x |
| 2 | 2,511 s | 1.86x |
| 4 | **1,648 s** | **2.83x** |
| 8 | 2,165 s | 2.16x |

**C=8 is slower than C=4.** vLLM's curve will differ in detail but not in shape. So two
sessions fanning out 4-wide each does *not* finish twice as fast as one — the GPU is the
shared resource, and past roughly four lanes you are queueing either way. The aggregate rate
is about the same; you have only chosen to interleave two tasks instead of finishing one
first.

That reframes the question. **One session's 4-wide fan-out is already the right amount of
concurrency for this box.** A second simultaneous fan-out is not something to engineer for —
it is something the queue absorbs, correctly, at the cost of both tasks feeling slower.

### Sizing `--max-num-seqs`

Target roughly `pool / p95_in_flight_sequence_length`, with preemption as the backstop:

- pool: 203,579 tokens measured (`models.nix:29-31`); re-measure after enabling prefix
  caching, since retained blocks change the free-block picture even though the pool is the
  same size
- p95 in-flight sequence: our `GPU KV cache usage: 10.3% - 24.8%` at `Running: 1` puts one
  sequence at roughly 20-50k tokens
- `203k / ~40k ~= 5`

So **`--max-num-seqs 6`** is a defensible first move from 3 — enough to let one fan-out run
at its full 4-wide plus a main session, without inviting the C=8 regression. Prefix caching
pushes this further by deduplicating the shared head across subagents of the same session.

The signal that we have gone too far is **preemption warnings in the vLLM log**, not OOM.
Watch for them after raising it.

### The FCFS caveat, and why to ignore it for now

`--scheduling-policy` defaults to `fcfs` (`vllm/config/scheduler.py:109-115`). So a burst of
8 subagents from session A queues *ahead* of session B's interactive main-session turn. The
human-facing request waits behind eight background ones.

vLLM does support `policy: "priority"` (lower value first), but priority arrives in the
request body and pi never sends it. Using it would need a proxy that injects `priority` based
on the model id — which is actually tractable, since subagents use the `-80k` alias and main
sessions use the base name, and llama-swap already rewrites the `model` field. **Not worth
building for a single dev.** Note it, and revisit only if interactive turns start feeling
starved behind fan-outs.

### Practical guidance

1. Raise `--max-num-seqs` to 6 **after** prefix caching lands, and watch for preemption.
2. Expect one fan-out to be the working concurrency. Two overlapping fan-outs will queue —
   that is the system working, not a limit to remove.
3. If interactive latency during a fan-out becomes the complaint, the lever is running fewer
   things at once, not a bigger number in the config. The card is the constraint, and it is
   already at its best around 4 lanes.

## 13. Evidence on MTP + prefix caching together — read before acting on §4

§4 said "two flags and prefix caching works." That was too confident. Searching vLLM's tracker
for this exact model turns up direct evidence on both sides, plus two bugs that land on our
hardware.

### The positive evidence: they did work together

[vllm#54360](https://github.com/vllm-project/vllm/issues/54360) benchmarks
**`unsloth/Qwen3.8-27B-NVFP4`** — our exact checkpoint — with `--kv-cache-dtype fp8` and
align-mode APC:

> **On `v0.24.0`, MTP + align-mode APC coexist correctly** on the same host/model: repeated
> 9,901-token prompt → 8,000 tokens hit, TTFT **7.27 s → 1.33 s**, with `mtp` k=3 active.

So the combination is not architecturally impossible. It shipped working.

### The negative evidence: it regressed after

Same issue, same host, same model, an 18,219-token prompt sent twice:

| nightly (v0.28.1rc1) config | TTFT req1 → req2 | `prefix_cache_hits_total` |
|---|---|---:|
| APC only, no spec | 9.46 s → **0.64 s** | **17,248** |
| APC + `mtp` k=3 | 23.6 s → 13.9 s | **0** |
| APC + `dflash` k=7 | 12.9 s → 12.5 s | **0** |

Silently inert — no crash, no warning. A commenter's agent-loop probe on **0.27.1-era**
builds of the same model shows an intermediate state rather than zero:

| arm | hit rate | mean TTFT (turns 2+) |
|---|---:|---:|
| no spec | 69.4% | 0.66 s |
| mtp K=3 | **42.5%** | **2.04 s** |
| dflash2 K=7 | 43.3% | 1.93 s |

There is an open fix: **[PR #52244](https://github.com/vllm-project/vllm/pull/52244)
"[Bugfix][V1] Restore hybrid GDN prefix-cache hits under MTP spec decoding."**

**We run v0.26.0, which sits between the working 0.24.0 and the degraded 0.27.1 and is not
measured in that report.** Nobody knows where we land. It is a ten-minute experiment:
`--enable-prefix-caching --mamba-cache-mode align`, send one long prompt twice, read
`vllm:prefix_cache_hits_total` off `/metrics`. **Measure it; do not assume §4's outcome.**

### The correctness bug, and what `models.nix:157` probably was

[vllm#53912](https://github.com/vllm-project/vllm/issues/53912) — APC + MTP on Qwen3.5-class
hybrids produces responses that degenerate into repeated `!` or come back empty:

| vLLM | APC | MTP | hit rate | malformed |
|---|---|---|---:|---:|
| **0.26.0** | on | k=2 | 27.5% | **25 / 2,636 (0.95%)** |
| 0.28.0 | on | k=2 | 31.7% | 4 / 495 (0.81%) |

Two findings that matter to us:

- **The corruption rate tracks the cache hit rate** — it appears only once the cache starts
  hitting.
- Root cause: `MambaManager.find_longest_cache_hit` accepts `drop_eagle_block` and **never
  acts on it**, so a block holding recurrent state written over draft positions that
  verification later *rejected* stays reachable and gets reused by the next request sharing
  that prefix. `FullAttentionManager` drops that block; the Mamba manager does not.

`models.nix:157` records *"Prefix caching off: caused incoherent rewrite loops on long
sessions"* on Qwen3.6. Same architecture family, same mechanism, and the reported signature —
degenerate repetition that scales with cache hits — matches. **That note was probably this
bug, not a misconfiguration.** It is still open (#43650, #48375).

### The fp8-KV interaction

The same issue notes that `--kv-cache-dtype fp8` *appears* to fix the corruption, but only by
destroying the cache: with fp8 KV, vLLM raises the attention block size (800 → 1600 in their
case) so one attention page covers one mamba page, and their ~1,700-token shared prefixes
stopped matching — hit rate 31.7% → ~10%, malformed 0/1,135.

We run fp8 KV, so we will get an inflated block size too. Our saving grace is prompt length:
at 20-40k tokens we still have 12-25 whole blocks to match, where their 1.7k case had one. But
if hit rates come back low, the lever is **`--prefix-match-unit`**
(`vllm/config/cache.py:56-67`), which sets *"the finest token boundary a prefix-cache hit can
land on... can be set finer than the physical KV cache block sizes (e.g. 32 vs a 1024-token
hybrid-model block) as long as every KV cache group's block_size is divisible by it."*

### The one that threatens §8 and §12

[vllm#54331](https://github.com/vllm-project/vllm/issues/54331) — **sm_120** (our RTX 5090)
running a **hybrid-GDN NVFP4** model **dies after ~7-8 minutes of sustained high-concurrency
inference whenever CUDA graphs are on.** SIGSEGV in `CUDAGraph::replay`; EngineCore dies and
every in-flight request raises `EngineDeadError`.

> The fault first appears in **0.26.0** and survives 0.26.0 → 0.27.0 → 0.27.1 → 0.28.0 ...
> vLLM 0.24.0 is clean on the identical box.

Five-arm dissection: `FULL_AND_PIECEWISE`, `PIECEWISE`, `TRITON_ATTN`, and
`expandable_segments` all crash; **only `--enforce-eager` survives**.

We have almost certainly not hit this because we run at `Running: 1` (§8). **Raising
`--max-num-seqs` to 6 and actually driving a fan-out is the exact condition that triggers
it.** Do that on a session you can afford to lose, and watch for `EngineDeadError`.
`--enforce-eager` is the escape hatch, but it costs the CUDA-graph decode speedup — the thing
producing our 41.8 rounds/s.

### Do not trade MTP away for prefix caching

If we are forced to choose, MTP wins, and it is not close. Our measured mean acceptance length
is 3.62-3.98, so MTP is worth ~**3.7x** on decode (41.8 rounds/s x 3.7 tokens vs 41.8 x 1).
For a representative turn — 40k prompt, 1,500 tokens generated:

| config | prefill | decode | turn |
|---|---:|---:|---:|
| MTP, no cache (**today**) | ~10 s | ~9.7 s | **~20 s** |
| cache, no MTP | ~0.5 s | ~36 s | **~36 s** |
| MTP + partial cache (42%) | ~5.8 s | ~9.7 s | **~15.5 s** |
| MTP + full cache | ~0.5 s | ~9.7 s | **~10 s** |

Disabling MTP to get clean prefix caching would make us *slower than we are now*. The upside
is capped at roughly 2x and only if the cache works fully.

### Revised plan

1. **Measure, do not assume.** Turn on `--enable-prefix-caching --mamba-cache-mode align`,
   keep MTP, send a long prompt twice, read `vllm:prefix_cache_hits_total`. Three outcomes:
   zero (nightly behaviour — revert and wait for #52244), partial (0.27.1 behaviour — keep it,
   it is still a win per the table above), or full (0.24.0 behaviour — excellent).
2. **Watch for `!!!!` and empty responses** for as long as it is enabled. That is #53912's
   signature and 0.26.0's measured rate is ~1%. If it appears, that also retroactively
   explains `models.nix:157`.
3. **Do not raise `--max-num-seqs` in the same change.** §8/§12's concurrency advice is sound
   in principle but #54331 makes sustained multi-lane load on sm_120 + NVFP4 + CUDA graphs a
   live crash risk on our exact version. Separate commit, separate test, keep
   `--enforce-eager` in your back pocket.
4. Vision, SearXNG, the browser tool, and the tier resizing are all unaffected by any of this
   and remain safe to do independently.
