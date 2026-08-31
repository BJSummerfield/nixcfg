# Local-LLM + agent stack: everything found, ranked by impact

**Date:** 2026-08-30
**Index for:** `2026-08-30-ninfer-spike.md`, `2026-08-30-qwen38-agentic-settings.md`,
`2026-08-30-agent-web-browser-toolkit.md`, `2026-08-30-spy-hunter-orchestration-review.md`.

Ranking is by *expected* wall-clock improvement to agentic coding, discounted by confidence
and by what it costs to try. Measured numbers are marked **[m]**; estimates **[e]**.

---

## Tier 1 — do these first: large, cheap, high confidence

### 1. Restart the orchestrator per work package

**[m]** The spy-hunter parent is one 21 MB session, 1,003 lines, since 06:08Z, with **10
`"type":"compaction"` events**. A session that compacts ten times lives near its threshold
(110,592 − 16,384 = **94,208 tokens**), and with `Prefix cache hit rate: 0.0%` **every turn
re-prefills ~90k** — ~26 s at the measured ~3,500 tok/s, against ~4 s for a fresh 15k parent.

**[e]** 1–2 hours of an 18-hour run spent re-reading context the model already had.

Cost: none. `ledger/README.md` already documents the recovery path; the mechanism was built as
a "compaction breaker" and is not used as one. Automate it with a `sp-wp` role agent
(`maxSubagentDepth: 1`, giving root → sp-wp → worker within the depth-2 budget) or an external
per-WP loop.

→ `spy-hunter-orchestration-review.md` §3, §8

### 2. Stop passing `model` in subagent dispatches

**[m]** `docs/skills.md`: *"Normal dispatches omit `model` and `tasks[].model`... those tool
fields are only for one-off model overrides."* Passing it sets `hasModelOverride`, and
`toThinkingLevel` then **discards the tier's thinking**, falling through to
`defaultThinkingLevel: "high"` → **`xhigh`**.

So every overridden subagent intended to run at `medium` is silently reasoning at `xhigh` — on
the parallel fan-out, where it costs most, and against `models.nix:57-64`'s own finding that
higher effort there is a net loss.

Cost: one rule in the orchestrator brief. Belt-and-braces: write the level into the model
string (`...-48k:medium`), which `extractThinkingSuffix` honours first.

→ `agent-web-browser-toolkit.md` §8

### 3. Measure prefix caching + MTP on v0.26.0

Highest upside in the whole list and genuinely uncertain, so the *measurement* ranks here, not
the adoption. **[m]** On `unsloth/Qwen3.8-27B-NVFP4` specifically:

| vLLM | MTP + APC together | Evidence |
|---|---|---|
| v0.24.0 | **works** — TTFT 7.27 s → 1.33 s | vllm#54360 |
| **v0.26.0 (ours)** | **unmeasured** | — |
| 0.27.1-era | degraded — 69.4% → 42.5% hit rate | vllm#54360 comment |
| nightly | **zero hits, silent** | vllm#54360 |

Also **[m]** vllm#53912: at 0.26.0 with APC + MTP, **25 / 2,636 responses malformed (0.95%)** —
repeated `!` or empty — and the rate tracks the hit rate. That is very likely what
`models.nix:157` recorded on Qwen3.6.

Ten minutes: `--enable-prefix-caching --mamba-cache-mode align`, keep MTP, send one long prompt
twice, read `vllm:prefix_cache_hits_total`. Then watch for `!!!!` for as long as it stays on.
**Do not disable MTP to get clean caching** — MTP is worth ~3.7× decode; that trade makes the
turn *slower than today*.

Bundle with it: **read the ledger stable-first** (GOAL → PLAN → LEDGER tail → CONTEXT →
task file). `CONTEXT.md` is rewritten every WP, so `README.md`'s current order invalidates
everything behind it. Two-line edit, only pays off if caching works.

→ `qwen38-agentic-settings.md` §4, §13; `spy-hunter-orchestration-review.md` §10

### 4. `supportsThinkingTokenBudget = false`

**[m]** vllm#44676, open, on exactly our parser pair (`qwen3_coder` + `qwen3`): Qwen3.5+ opens
tool calls *inside* `<think>` without closing it; `ThinkingBudgetStateHolder` keeps counting
tool-call argument tokens against the budget and, when it runs out, force-injects `</think>`
**into the middle of the JSON arguments**. Reporter's differential: small budget → 3 of 4 runs
corrupted; large → 0 of 8; thinking off → 0 of 12.

pi sends 16,384 (main) and 7,168 (48k alias). Control thinking via `reasoning_effort` instead —
prompting can't corrupt a tool call; logit forcing demonstrably can.

→ `qwen38-agentic-settings.md` §3

### 5. Raise `--max-num-batched-tokens`

**[m]** Prefill dominates our turns (20k and 40k prompt tokens inside single 10-second windows).
2048 is low. Raising it is also *required* for `align` mode's
`block_size <= max_num_batched_tokens` assert. **[e]** 10–30% on prefill.

→ `qwen38-agentic-settings.md` §4

---

## Tier 2 — real gains, moderate cost or gated on Tier 1

### 6. SearXNG + per-agent web access

**[m]** `provider = "exa"` pins one metered provider and disables the fallback chain.
`searxng.ts` is supported and tried *first* in `auto` mode. Separately,
`superagents.extensions` is `null`, so **no subagent has `pi-web-access` at all** — not even
`sp-research`.

This has cost real time: *"web_search rate-limited today"* is a standing fact in spy-hunter's
CONTEXT.md, R02 failed review once on wrong game attribution, R03 lost two subagent attempts.
It also **blocks item 8** — research can't move off the parent while only the parent has web.

Gotcha: SearXNG serves HTML only by default; `search.formats` must include `json`.

→ `agent-web-browser-toolkit.md` §1–2, §6

### 7. Vision on vLLM

**[m]** We already own the tower (0.86 GiB, 333 `model.visual.*` entries). The startup OOM was
`preprocessor_config.json`'s `longest_edge: 16777216` — a **16.78 MP** default profiling shape,
16,384 vision tokens for one image. Capping to 1 MP is 16× smaller:

```
--limit-mm-per-prompt '{"image":1,"video":0}'
--mm-processor-kwargs '{"max_pixels": 1048576}'
--mm-processor-cache-gb 1
```

A screenshot then costs ~1,024 tokens. **Ranked here, not higher, because it does nothing until
something produces images** (item 9).

→ `qwen38-agentic-settings.md` §9

### 8. Overlap research with review; use `sp-review`

**[m]** The spy-hunter parent personally wrote every review verdict (W24a…W29) plus the W24,
MAME, and W28b research, and spent 18:09→18:30 reviewing W29 with nothing else running.
W33/W34 research is `todo` and independent — a legitimate 2-wide overlap available today.
**[e]** ~20% off a ~70-minute mean WP.

Depends on item 6 for the research half.

→ `spy-hunter-orchestration-review.md` §4–5

### 9. Browser tool, text mode first

`pi-web-access` has **no browser** — `undici` + `linkedom` + `readability`, no JS execution, so
an SPA arrives as an empty shell. Add headless chromium/playwright and a script emitting DOM,
accessibility tree, console errors and failed requests. **Text first**: an LLM reasons better
over `width: 0px` than over pixels. No plugin needed — pi already takes images from `read` on a
PNG and text from bash stdout.

Then `--screenshot` as a second mode. That is what makes item 7 worth anything, and it is the
only channel for canvas/WebGL — which is exactly spy-hunter's open
`[to-verify]`: *"boat art taste (W31 human audit)"*, currently a hard human gate.

→ `agent-web-browser-toolkit.md` §3–5

### 10. Tier resize and cleanup

`cheap` 49,152 → **81,920** moves the compaction threshold 32,768 → 65,536, so most subagent
tasks never compact (one avoided compaction ≈ 25–40 s). Delete `balanced` — no bundled agent
references it. Add an `orchestrator` tier only if item 1 takes the `sp-wp` route.

**[m]** Declared windows are compaction triggers, not allocations — vLLM allocates on demand,
so a bigger window costs nothing until used, and we sit at 10–25% KV.

→ `qwen38-agentic-settings.md` §11; `agent-web-browser-toolkit.md` §9

---

## Tier 3 — worth doing, small or gated

### 11. A/B `speculativeTokens = 4`

**[m]** Measured per-position acceptance at k=3 is 0.957 / 0.902 / 0.852 (up to
0.99 / 0.975 / 0.988). Position 3 still accepting 85–99% means the draft isn't exhausted.
Compare **mean acceptance length**, not rate. Don't jump to 5 — ninfer#92 reports Qwen3.8 at
MTP5 entering repeated-token loops. **[e]** 5–10%.

### 12. `--max-num-seqs` 3 → 6

**Gated on a crash.** **[m]** vllm#54331: **sm_120** (our 5090) + hybrid-GDN **NVFP4** + CUDA
graphs dies after ~7–8 min of sustained high-concurrency load. *"First appears in 0.26.0"*,
clean on 0.24.0, only `--enforce-eager` survives. We have not hit it because we run at
`Running: 1` — raising this is the trigger condition. Separate commit, disposable session.

Also **[m]** concurrency does not create capacity: C=4 is the peak, C=8 is *slower* than C=4.
One session's 4-wide fan-out is already the right amount for this box.

### 13. Swap to `@gotgenes/pi-subagents`

Genuinely better engineering — `thinkingLevel` a validated typed field, frontmatter *fills*
rather than *overrides* caller options, throws on an invalid level, `locked` frontmatter stops
the model choosing its own tier, `inheritContext` defaults false, configurable concurrency, and
`compactionCount` per record. In-process, so no CLI string boundary — the root cause of item 2.

Ranked here because **it is not where the hours are**. It makes item 1 easier to build
correctly and kills item 2's papercut permanently. Do it non-destructively: install alongside,
port `sp-research` first, compare.

### 14. Housekeeping

- Delete the stale `--override-generation-config` comment (`llama-swap.nix:52`) — it claims to
  pin a "precise-coding value" that is identical to the repo default for 3.8.
- `--prefix-match-unit` if item 3 shows low hit rates (fp8 KV inflates the block size).

---

## Explicitly not worth doing

| | Why |
|---|---|
| **Migrate to NInfer** | Field reports from our exact workload (Cline + Qwen3.8-27B NVFP4) measure 16% of requests taking **30–36 s** because its checkpoint anchors on human turns and agent loops have none. One reporter switched to llama.cpp and called it *"a genuine no-go for agentic coding."* Prefill is a wash anyway (0.6% apart at 260k). Revisit if ninfer#62 closes. |
| **Drop llama-swap** | Zero performance benefit — a Go proxy on a local veth. The fan-out context limits are pi-side, not llama-swap-side, so nothing is at risk either way. `--served-model-name A B` replaces the alias in one line if you want the simplification for its own sake. |
| **Wider fan-out than 3** | The build chain is serial by construction — every WP edits the same crates and re-verifies the same frame pins. And the server peaks near 4 lanes. |
| **A fourth context tier** | A tier only pays for itself if a distinct population uses it, and a session is bound to one entry for life. |
| **Lower temperature "for precise coding"** | 1.0 is the model card's thinking-mode value. Deviating causes degradation. |
| **Drop MTP to get clean prefix caching** | MTP is worth ~3.7× decode. That trade makes the turn slower than today. |

---

## Suggested commit order

1, 2 (free, today) → 4 (one line) → 3 + ledger reorder (measure, watch for `!!!!`) → 5 →
6 → 8 → 7 + 9 → 10 → 11 → 12 (disposable session) → 13 (evaluate alongside).

One commit each, so a regression is attributable.
