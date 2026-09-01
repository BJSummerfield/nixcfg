# Plan: updating the nix repo

Derived from `05-change-and-keep.md`. Upstream status verified 2026-09-01 (see
`02-vllm-and-model.md` §3).

## Sequencing rationale

The three changes that matter touch different layers and are verified by different
signals, so they go in separate PRs. Bundling them makes the result unreadable — and the
whole point of the measurement work was to be able to attribute effects.

The counters on `/upstream/<model>/metrics` are **cumulative since engine start** and reset
on every model restart. That is convenient: each PR that restarts vLLM gives a clean
per-config counter set. `data-vllm-metrics-snapshot.txt` is the v0.26.0 baseline
(3,201 requests) and needs no re-capture.

```
PR 1  engine bump + observability      -> restart, measure 1 day
PR 2  scheduling (concurrency/window)  -> restart, measure 1 day
PR 3  pi-side compaction               -> no server restart, measure 1 day
then  C7 spec tokens, C9 thinking level, NInfer bench
```

---

## PR 1 — `llm/vllm-0.28-and-observability`

Goal: land the upstream correctness fix, and make the next two PRs measurable.

### 1a. Bump the image — `modules/local-llm/nixos.nix`

```nix
- vllmImage = "docker.io/vllm/vllm-openai:v0.26.0";
+ vllmImage = "docker.io/vllm/vllm-openai:v0.28.0";
```

Rewrite the pin comment. Current text justifies 0.26.0 as "first release after Qwen3.8's
day-0 support announcement". Replacement should say: v0.28.0 is the **first tag containing
PR #51113** (`c56f169d9ae4`, merged 2026-08-06), the merged half of the hybrid-Mamba
prefix-cache × MTP correctness fix; it is not in v0.27.0/v0.27.1 despite merging before
them. #51113 closed #43559 (20% accuracy drop); **#47194 (tool-call leakage) is still
open**, so this is an experiment for our symptom, not a promised fix.

Also note in the comment: 0.28.0 turns prefix caching on by default for Mamba models
(#50991), so our explicit `--enable-prefix-caching` becomes redundant-but-harmless. Keep it
explicit — it documents intent and survives a future default flip.

### 1b. Persist vLLM's stdout — `modules/local-llm/llama-swap.nix`

**Check this first, it may be free.** llama-swap runs as a systemd service inside the
`local-llm` container, and it captures the upstream's output. If that already reaches the
container journal, there is nothing to build:

```bash
sudo journalctl -M local-llm -u llama-swap | grep -i 'GPU KV cache size'
```

If the startup lines are there, C5 collapses to a comment in `models.nix` pointing at that
command, and the tuning notes stop telling readers to consult a log that `--rm` destroys.

If they are not, add to the `vllmArgs` list right after the `--rm --replace --pull=never`
line:

```nix
  "--log-driver=journald --log-opt tag=vllm-${lib.toLower name}"
```

**Risk to check on rollout:** llama-swap's `/logs` endpoint reads the upstream's attached
stdout. `--log-driver` is a server-side storage option and should not affect the attach
stream over the podman API socket, but verify `/logs` still shows vLLM output after the
switch. If it goes blank, revert this hunk only — it is independent of 1a.

### 1c. Scrape the metrics — new, small

The endpoint is `http://192.168.100.25:8081/upstream/Qwen3.8-27B-NVFP4/metrics` from the
host (or the tailnet URL from anywhere). A full Prometheus is overkill for a single-user
box. A systemd timer writing timestamped scrapes into `/var/lib/local-llm/metrics/` is
enough to turn future tuning arguments into diffs, and costs ~15 lines in
`modules/local-llm/nixos.nix`.

Model name is available at eval time (`catalog.default`), so the URL need not be hardcoded.

### 1d. Re-probe `cached_tokens` after the switch

```bash
B=https://llm.mist-gamma.ts.net:8443
P=$(for i in $(seq 1 340); do printf 'The quick brown fox jumps over the lazy dog number %d. ' $i; done)
jq -n --arg p "$P" '{model:"Qwen3.8-27B-NVFP4",messages:[{role:"user",content:$p}],max_tokens:2,temperature:0}' \
  | curl -s $B/v1/chat/completions -H 'content-type: application/json' -d @- | jq .usage
```

On v0.26.0 this returns `"prompt_tokens_details": null`. If v0.28.0 populates it, pi's
`cacheRead` starts reporting the ~78% hit rate per turn and the DON'T entry in
`05-change-and-keep.md` gets deleted rather than softened.

### Verification for PR 1 (after ~1 day of normal use)

| Signal | Baseline (v0.26.0) | Where |
| --- | --- | --- |
| malformed tool calls | 120 in 14.3 h (46 empty-arg, 27 JSON-string) | `rg -c 'Validation failed for tool'` over new sessions |
| `finished_reason="length"` | 124 / 3,201 = 3.9% | `vllm:request_success_total` |
| prefix cache hit rate | 78.0% of prompt tokens | `prompt_tokens_cached_total / prompt_tokens_total` |
| MTP acceptance | 67.9%, 3.04 tok/step | `spec_decode_num_accepted_tokens_total / _draft_tokens_total` |
| `prompt_tokens_details` | `null` | the probe in 1d |

**Rollback:** revert 1a alone (one string). 1b/1c are independent and additive.

---

## PR 2 — `llm/concurrency-and-window`

Goal: stop queueing behind a 2-lane cap. C2 and C3 must ship together — C3 is what makes
room for C2.

### 2a. `modules/local-llm/models.nix`, Qwen3.8 entry

```nix
- maxModelLen = 131072;
+ maxModelLen = 102400;

- headroom = 32768;
+ headroom = 4096;

  vllm = {
-   maxNumSeqs = 2;
+   maxNumSeqs = 4;
```

`contextWindow` in `settings.nix` is derived as `maxModelLen - headroom`, so
`102400 - 4096 = 98304` — **byte-identical to today. No pi behaviour changes.**

The three numbers must move together. Changing `maxModelLen` alone would silently move
pi's window.

### 2b. Rewrite the comments that the measurements falsify

This is most of the diff, and it is the part that stops the next person re-deriving the
wrong rule. Specifically:

- **`headroom`'s stated purpose is wrong.** The current comment says it must be
  `>= maxTokens - 16384` to cover the band between pi's compaction threshold and vLLM's
  ceiling. It cannot do that: pi clamps output against its *own* `contextWindow`
  (`clampMaxTokensToContext`, `CONTEXT_SAFETY_TOKENS = 4096`), so the unguarded band is
  `reserveTokens - 4096` and depends only on a pi setting. `headroom` is drift margin
  between pi's token estimate and vLLM's count, nothing more — 4096 is ample.
- **The KV pool is 197,283 tokens**, not "~170k interpolated". Cite
  `vllm:cache_config_info{kv_cache_size_tokens}` and drop the 2048/8192 interpolation,
  which predates prefix caching and `align` and describes a configuration we do not run.
- **`maxNumSeqs = 2`'s rationale cites a stale dataset.** Replace with the measured curve:
  1→2 lanes is free (9.7 → 9.8 s/1k output), the 3rd costs +27%, the 4th +89%, ≥6 +260%,
  and 55% of requests arrive with ≥3 in flight.
- **`2 × 68k against the pool` assumes zero block sharing** while 78% of prompt tokens are
  cache hits. Lanes are cheaper than that arithmetic.
- **Preemption is not being avoided by the low cap** — `num_preemptions_total = 3,181`
  over 3,201 requests, i.e. ~1 per request already at `maxNumSeqs = 2`.
- **Record why `maxModelLen` is 102400**: pi cannot structurally exceed
  `contextWindow - 4096 = 94,208`, and `kv_cache_max_concurrency` is
  `kv_cache_size_tokens / max_model_len` — 1.505 at 131072, 1.93 at 102400. The 36,864
  tokens removed described requests that could not exist.

State the trade explicitly so the alternative stays visible: `headroom = 4096` at
`maxModelLen = 131072` would give ~110k of usable history instead of ~65k, at
`kv_cache_max_concurrency = 1.55`. We took lanes because concurrency is the measured
bottleneck and history is not.

### 2c. Add an eval test — `tests/devboxes.nix`

The file already imports `models.nix` as pure data and asserts on it (see the
"nothing requests low thinking" check). Add, in the same style:

```
name = "headroom leaves drift margin above pi's own safety reserve";
ok   = every enabled model has headroom >= 4096;
```

with a comment recording *why* 4096 and why the old `maxTokens - 16384` rule was wrong.
The value of this is not the arithmetic — it is that the next person to edit `headroom`
reads the corrected reasoning at the point of edit.

### Verification for PR 2

Re-run the concurrency analysis from `01-measurements.md` §3 against a fresh
`/api/metrics/activity` pull — **remember `start = timestamp - duration_ms`**. Expect the
knee to move from 3 to ~5. Watch:

- `vllm:request_queue_time_seconds` — baseline mean 3.04 s, 4.4% over 20 s, tail to 480 s.
- `vllm:num_preemptions_total` per request — baseline ~1.0. If this climbs well above 1,
  the pool is the constraint after all and `maxNumSeqs` should come back to 3.
- `vllm:kv_cache_usage_perc` sampled over the day.

**Rollback:** revert the three numbers together.

---

## PR 3 — `pi/compaction-reserve`

### 3a. `modules/pi-coding-agent/settings.nix`

```nix
  settings = {
    ...
+   compaction.reserveTokens = 32768;
  };
```

Key path confirmed against the installed pi: `settings-manager.js:518` reads
`this.settings.compaction?.reserveTokens ?? 16384`. `home.nix` serialises `data.settings`
straight to `~/.pi/agent/settings.json` and reinstalls it on every activation, so this is
declarative and a live edit cannot drift.

Comment should carry the arithmetic, because none of it is guessable from the value:
compaction fires at `contextWindow - reserveTokens`; pi clamps output to 1 token at
`contextWindow - 4096`; the unguarded band is the difference. At the default 16384 that
band is 12,288 tokens, and any single tool result larger than it lands a turn in the clamp
— 15 turns in 14.3 h emitted exactly one token after a full ~94k prefill.

**Cost, stated plainly:** compaction fires at 65,536 instead of 81,920 — 20% earlier, so
more often (47 compactions in the baseline run), and less live history per turn. Also
consider `compaction.keepRecentTokens` (default 20000) if the summaries start losing
too much.

### Verification for PR 3

```bash
# should approach zero
jq -r 'select(.message.stopReason=="length" and .message.usage.output<=8)' <session>.jsonl | wc -l
# baseline: 15 of 24 length-stops, out of 1287 turns
```
and `vllm:request_success_total{finished_reason="length"}` (baseline 3.9%). Count
compactions per session as the counterweight (`jq 'select(.type=="compaction")'`).

---

## After measurement

- **C7 — `speculativeTokens` 3 → 4.** Only after PR 1, because MTP is half of the bug
  0.28.0 addresses; tuning it on the old image measures the wrong thing. Justification:
  per-position acceptance is 80.7 / 66.6 / **56.4%** — position 2 is not exhausted.
- **C9 — `defaultThinkingLevel`.** The largest untested lever: decode is 68.6% of latency,
  output tokens are the only real cost, and every turn currently defaults to the most
  expensive effort the template accepts. Needs an A/B measuring
  `vllm:generation_tokens_total` per unit of work, not an opinion.
- **NInfer bench** — the one-day scratch build in `04-ninfer.md`. Worth doing regardless of
  outcome, because its `--request-log-jsonl` reports the cached-token counts vLLM has been
  unable to report reliably.

## Not doing

Removing llama-swap. It is the only route to `/upstream/<model>/metrics` and
`/api/metrics/activity`, both of which every verification step above depends on — and it
is the rollback path if PR 1 goes badly. Revisit after the NInfer bench, not before.
