# vLLM setup and the Qwen3.8 model config — findings

Evidence for everything here is in `01-measurements.md`.

## 1. What is running today

```
docker.io/vllm/vllm-openai:v0.26.0            # pinned in modules/local-llm/nixos.nix
--model /model  --served-model-name Qwen3.8-27B-NVFP4
--kv-cache-dtype fp8
--max-model-len 131072
--gpu-memory-utilization 0.95
--limit-mm-per-prompt '{"image":0,"video":0}'
--max-num-batched-tokens 4096
--max-num-seqs 2
--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3
--override-generation-config '{"temperature": 1.0}'
--speculative-config '{"method":"mtp","num_speculative_tokens":3}'
--enable-prefix-caching --mamba-cache-mode align
```

Started on demand by llama-swap over the host podman socket, `--rm --replace`, one
resident model, `ttl = null` (never unloaded). Weights: `unsloth/Qwen3.8-27B-NVFP4`
fetched as a nix `linkFarm` of `fetchurl` blobs. Card is an RTX 5090 (31 GiB usable,
Blackwell/NVFP4), dedicated — no compositor co-tenant.

pi side (`modules/pi-coding-agent/settings.nix`): `contextWindow = maxModelLen − headroom
= 98,304`, `maxTokens = 32768`, `defaultThinkingLevel = "high"` → mapped to chat-template
`reasoning_effort: "xhigh"`, `subagents.maxThinking = "xhigh"`, no `defaultModel`.

## 2. The tuning premise in `models.nix` is inverted by the data

`models.nix` reasons almost entirely about the KV pool: how many tokens it holds, how
`maxNumBatchedTokens` trades against it, how many lanes fit. The measured stack says:

- **78% of prompt tokens never get computed.** Prefix caching + `align` is working, and
  working well. Input is ~2 µs/token at the request level.
- **Decode is 68.6% of end-to-end latency.** Prefill is 16.0%, queueing 14.8%.
- The KV pool is **197,283 tokens**, not the "~170k" the comments interpolate. The
  measurement note in `models.nix` telling you to read the startup line is right; the
  number it left in place is stale.
- `2 × 68k = 136k against the pool` over-counts, because it assumes zero block sharing —
  and 78% of blocks *are* shared. The lanes are cheaper than the arithmetic says.

Practical consequence: **context-window and KV-pool tuning are close to performance-neutral
here.** They should be tuned for *correctness* (not tripping pi's clamp, not truncating
review verdicts) and left alone otherwise. The performance levers are concurrency,
speculative decoding, and how many output tokens the agent asks for.

## 3. The image pin has a known correctness bug in exactly this flag combination

vLLM issue [#47194](https://github.com/vllm-project/vllm/issues/47194) — *"Qwen3.6 hybrid
model with prefix caching + MTP3 causes tool-call leakage and needle recall failure, while
the no-MTP path is correct"*. Reporter's differential:

- prefix cache + **no** MTP: 90–98% cache hits, tool calling and recall correct.
- prefix cache + **MTP3**: 83.9% cache hits, tool calls 2/10 pass, multi-turn tool use
  0/5, needle recall fails at 10k/30k, `<tool_call>` XML leaks as plain text.

PR [#47861](https://github.com/vllm-project/vllm/pull/47861) — *"Fix MTP prefix cache
correctness for hybrid Mamba models"* — names the affected configuration precisely:
Qwen3.5/3.6-style hybrid, prefix caching on, MTP, `mamba_cache_mode="align"`. Symptoms:
*"tool-call leakage, recall failures, and degenerate generations on cache-hit paths."*
It names #47194 and #43559 (20% accuracy drop with prefix caching + MTP) as the reports it
addresses -- but see the verification table below for what actually closed.

**That is bit-for-bit the running config.** And the observed symptom rate is non-trivial:
120 malformed tool calls in 14.3 h, 46 of them with completely empty arguments (§7 of
`01-measurements.md`).

### Verified upstream status (checked 2026-09-01 via `gh api`)

| Item | Status | Detail |
| --- | --- | --- |
| PR #47861 | **closed, NOT merged** | `merged: false`, no merge commit — conflicts |
| PR #51113 *"Keep mamba align prefill chunks block-aligned past last_cache_position"* | **merged 2026-08-06 17:21:00Z** | commit `c56f169d9ae4` |
| Issue #43559 *(20% accuracy drop, prefix caching + MTP)* | **CLOSED / completed 2026-08-06 17:21:01Z** | one second after #51113 merged — #51113 is what closed it |
| Issue #47194 *(tool-call leakage + recall failure)* | **STILL OPEN** | not closed by #51113 |
| Issue #44676 *(thinking budget corrupts tool-call args)* | **STILL OPEN** | the `supportsThinkingTokenBudget = false` workaround stays required |
| Issue #44961 *(`cached_tokens` always null)* | closed 2026-07-14, **but see §5** | reopened in practice |

**Which release first contains #51113 — verified, not inferred:**

```
release dates:  v0.26.0 2026-07-27 | v0.27.0 08-10 | v0.27.1 08-11 | v0.28.0 08-26
compare v0.26.0...c56f169d9ae4  -> diverged (ahead 737, behind 12)
compare v0.27.0...c56f169d9ae4  -> diverged (ahead 181, behind 17)
compare v0.27.1...c56f169d9ae4  -> diverged (ahead 181, behind 21)
compare v0.28.0...c56f169d9ae4  -> behind   (ahead 0,   behind 420)   <-- ancestor
```

Despite merging on 08-06, four days before v0.27.0 shipped, #51113 is **not** in v0.27.0
or v0.27.1 — those release branches were cut earlier and carry their own commits.
**v0.28.0 is the first tag containing it.** So the bump target is right, and there is no
cheaper intermediate hop.

**What this does and does not promise.** #51113 demonstrably fixed the *accuracy-drop* half
of the prefix-cache × MTP interaction (#43559). The *tool-call leakage* report (#47194) is
still open. So v0.28.0 is a well-founded change against a confirmed bug in the same code
path — but treat the effect on our 120 malformed tool calls as a **measurable experiment,
not a guaranteed fix**. Capture the baseline before switching (see `05-change-and-keep.md`
C1).

`models.nix` already anticipated this: *"Watch for 3.6's failure signature… if it
reappears, the A/B is this flag first, then speculativeTokens second."* The signature is
here, and there is now an upstream name for it. The A/B is still not the first move —
bumping the image is, because it is reversible in one string and the flag A/B costs you
the 78% cache hit rate while you run it.

### What v0.28.0 changes for us
- Prefix caching **on by default for Mamba models** (#50991) — upstream now considers
  `align` mode the normal path, not an opt-in.
- `max_num_batched_tokens` default 8192 → 16384 (#51726). Ours is explicitly 4096 and
  should stay explicit.
- No documented breaking changes to the CLI flags we use, and no
  `--mamba-cache-mode` deprecation in the notes.

## 4. `maxModelLen` declares 36,864 tokens pi can never use

pi's clamp (`01-measurements.md` §6) guarantees `input + max_tokens ≤ contextWindow − 4096
= 94,208`. But `--max-model-len` is 131,072, and vLLM derives

```
kv_cache_max_concurrency = kv_cache_size_tokens / max_model_len = 197,283 / 131,072 = 1.505
```

That is vLLM telling you it sizes itself for **1.5 concurrent sequences** — below the
`--max-num-seqs 2` you asked for. Dropping `--max-model-len` to 98,304 changes no
observable pi behaviour (nothing can reach past 94,208) and takes that figure to 2.01.

This is the cheapest available change: it costs nothing and it is the one number in the
config that is provably describing requests that cannot exist.

## 5. `cacheRead` reads 0 — upstream calls it fixed; it is not fixed on our pin

pi *does* map it (`openai-completions.js:1108`: `rawUsage.prompt_tokens_details?.cached_tokens
?? rawUsage.prompt_cache_hit_tokens ?? 0`). llama-swap's activity records show
`cache_tokens: -1` for the same reason.

vLLM issue [#44961](https://github.com/vllm-project/vllm/issues/44961) was **closed as
completed on 2026-07-14** by a maintainer, stating `num_cached_tokens` is mapped to
`prompt_tokens_details.cached_tokens` in all four OpenAI chat/completion response paths
and "confirmed working in the 0.23–0.25.1 releases". A user reported on 2026-08-17 that
they still see the bug.

**Directly tested against our running v0.26.0 on 2026-09-01** — a ~5k-token prompt,
`max_tokens: 2`:

```json
{"prompt_tokens":5010,"total_tokens":5012,"completion_tokens":2,"prompt_tokens_details":null}
```

`prompt_tokens_details` is `null`, not a zeroed object. So the field is genuinely not
being emitted on the version we run, whatever main does.

Practical consequence: this is **not** the permanent unfixable gap the earlier draft of
this document claimed. It is a plausible free win from the C1 bump. Re-run the probe above
immediately after switching to v0.28.0; if `cached_tokens` appears, pi's `cacheRead` starts
reporting the 78% hit rate per turn and the whole prefix-cache question becomes visible
from the agent side instead of only through a Prometheus scrape.

Until then, the hit rate is only observable via `vllm:prompt_tokens_cached_total` on
`/upstream/<model>/metrics`.

## 6. Model-config observations that hold up, and ones that do not

**Holds up:**
- `temperature 1.0 / top_p 0.95 / top_k 20 / min_p 0.0` — matches the 3.8 model card.
- `supportsThinkingTokenBudget = false` with the reasoning-effort route through
  `chat_template_kwargs` — vllm#44676 is real and the workaround is sound.
- `thinkingLevels` folding `low → medium` — the effort floor.
- `--limit-mm-per-prompt '{"image":0,"video":0}'` — text-only, weights already ~22 GiB.
- Dropping the fan-out alias (PR #148). The data is unambiguous: 27 hard 400s and two
  dead reviewer runs before, zero after.

**Does not hold up:**
- `maxNumSeqs = 2`, justified from `run-history.jsonl` showing "~441 s of genuine 2-wide".
  That dataset predates the pi-subagents fan-out. Current traffic is ≥3 in flight for
  55.0% of requests, with a measured knee exactly at the third.
- The "~170k pool at 4096 batched tokens" interpolation. It is 197,283.
- `headroom = 32768` as protection against the compaction band. `headroom` does not affect
  that band at all — the band is `reserveTokens − 4096`, and `reserveTokens` is a pi
  setting nothing in this repo sets.
