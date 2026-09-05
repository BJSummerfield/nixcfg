# Local LLM: config rationale for `modules/local-llm/*`

Status: current as of 2026-09-05, redtruck, Qwen3.8-27B-NVFP4, vLLM nightly
`8a728663c1c3eeace834a95f5654fa653cc1998c` (MTP re-enabled by #165/#166).

This is the long-form version of the tuning comments in `modules/local-llm/models.nix`
and `modules/local-llm/vllm-service.nix` — each number in those files carries a one-line
summary and a pointer here. For the MTP re-enable decision itself (mechanism analysis,
upstream issue tracking, deploy/rollback spec), see `docs/ninfer-vs-vllm-2026-09-03/`,
especially `03-mtp-prefix-cache-correctness.md`, `05-patch-efficacy.md` and
`06-mtp-reenable-spec.md`. The numbers below are the **post-deployment measurements**
taken after that spec shipped — they supersede that spec's pre-deployment projections
where the two disagree (e.g. the spec projected `maxNumBatchedTokens` staying at 4096;
the deployed value is 2048).

## Qwen3.8-27B-NVFP4 (`models.nix`)

### maxModelLen / headroom coupling

Native context is 262144; `maxModelLen = 102400` is sized for concurrency, not reach.
vLLM reports `kv_cache_max_concurrency = pool / maxModelLen` and schedules against it, so
a larger window structurally overcommits the lanes.

`maxModelLen` and `headroom` travel together: `settings.nix` derives pi's `contextWindow`
as `maxModelLen - headroom`, so editing either alone silently moves pi's window.

### headroom = 4096

This is drift margin between pi's token estimate and vLLM's count, and nothing else. pi's
`clampMaxTokensToContext` already shrinks `max_tokens` to `contextWindow - estimate - 4096`
on every request, so the largest total it can emit is `contextWindow - 4096` whatever
`maxTokens` says — headroom is unrelated to `maxTokens`. It also cannot protect the band
between pi's compaction threshold and vLLM's ceiling: that band is `reserveTokens - 4096`
wide and moves only with pi's `settings.compaction.reserveTokens`.

### vision.maxImages = 3, width = 1280, height = 800

Unsloth ships the vision tower unquantized in bf16 alongside the NVFP4 language model;
omitting the `vision` block serves text-only and never loads it. `width`/`height` are
memory-profiling hints and scale quadratically in the encoder's attention — 16MP OOMed
startup when no limit was set.

`count` is a per-**prompt** budget, not per-message, and a chat client resends the whole
conversation every turn — so it is really "images one session may accumulate before it
dies." The first request carrying `count+1` fails with `400 At most N image(s) may be
provided in one prompt`, and so does every request after it, including the compaction that
would have evicted them. Nothing recovers from inside; under the budget, compaction does
drop them. It was 1, and two `read` calls fourteen seconds apart locked a session on
2026-09-01. `AGENTS.md` is generated from this number.

`8 -> 3` gives MTP room. Note what this does and does not buy: the startup line reads
"profiled with 1 image items of the maximum feature size," so peak activation is set by
width/height and not by count, and the encoder cache budget is its own 16384 tokens either
way. The saving is therefore small and the cost is concrete — 3 is the number of images a
session may accumulate before every subsequent request 400s, which is what made 1
unusable. **If a session ever locks that way again, this is the first number to put back,
not the last.**

### vllm.gpuMemoryUtilization = 0.955

The card is dedicated to vLLM, but ~0.5 GiB of driver/context sits outside vLLM's
accounting: 0.97 left only ~0.4 GiB of slack.

0.95 was right until MTP came back and does not fit any more. With `speculativeTokens` set
and `maxNumBatchedTokens` at 4096 it OOMs at startup — not in KV allocation, which
succeeds, but afterwards in FlashInfer autotune, which wants 272 MiB and finds 73 MiB.

That is headroom for a warmup pass, not slack. The autotuner runs a max-size forward, so an
OOM there is the shape of the first real 64k request — disabling the autotune would move
the failure out of boot and into production, which is the wrong direction.

0.955 works because `maxNumBatchedTokens` came down to 2048 with it: peak activation is
0.97 GiB at 2048 against 1.25 at 4096, and that 0.28 GiB is what buys back the fraction.
The pair moves together — raising the batch without lowering this reintroduces the OOM.

Deliberately a fraction and not `--kv-cache-memory`, though the byte form is measurably
better and `vllm-service.nix` still emits it when a model sets `kvCacheMemory`.
`5995147264` was verified here (5.58 GiB, 138,693 tokens, +32%) and it is the thing to
reach for if the pool gets tight. It is not the default because the byte count does not
travel: vLLM derives it from free memory at boot, so an image bump, a driver change, or
anything else resident on the card silently invalidates it, and the failure mode is a box
that will not start. A fraction re-derives itself every boot.

### vllm.maxNumSeqs = 2

A scheduler cap, not a reservation — nothing is allocated by raising it. What it decides is
what happens to the request that does not fit: admitted and preempted, or queued. Both
wait; only one of them discards a half-built request first.

The number that matters is pool per lane against a real turn, not the lane count on its
own. Turns measured here run 64-68k, and pi cannot exceed 81,920 because that is where it
compacts (`contextWindow` minus its own `reserveTokens`), so 81,920 is the ceiling a lane
must cover, not `maxModelLen`. Measured pools (the last row is the pre-MTP baseline, for comparison):

| config | pool |
|---|---:|
| 0.93 / 4096 | 104,992 |
| 0.93 / 2048 | 112,769 |
| byte pin | 138,693 |
| pre-MTP (3 lanes, 70,637 each) | 211,911 |

Two lanes need ~136k to cover a 68k turn and ~164k to cover the 81,920 ceiling. So 2 is
what the pool supports and 3 is not close: a third lane would admit a request the pool
cannot hold and preempt something to make room. Operator report from the 3-lane era agrees
— rarely actually at 3, and it thrashed when it got there.

Do **not** read `Maximum concurrency ... N.NNx` from the startup line as the lane count:
that is `pool / maxModelLen`, and `maxModelLen` is a per-request ceiling nothing reaches.
Divide by the real turn size.

The arithmetic above is naive in one direction: prefix caching dedups blocks **across**
concurrent requests, so subagents sharing a system prompt and repo context do not each pay
for it, and true residency can sit under 2 x 64k. That is unmeasured, and it is the only
thing that would make 3 viable. Evidence for trying it would be
`vllm:num_preemptions_total / vllm:request_success_total` staying near zero (0.34% now,
99.4% on the last MTP-on soak) while queue time climbs — and it earns its own commit with
its own before/after, not a bump in passing.

### vllm.maxNumBatchedTokens = 2048

Trades directly against the KV pool: vLLM profiles peak activation at this chunk size and
sizes the pool as the remainder, so raising it shrinks the pool. Measured on this model,
same flags otherwise: 4096 -> 1.25 GiB peak activation and 104,992 tokens at 0.93;
2048 -> 0.97 GiB and 112,769. The 0.28 GiB is what pays for `gpuMemoryUtilization` 0.955
above, and the two must move together.

2048 is not free. vLLM prints "max_num_scheduled_tokens is set to 2048 based on the
speculative decoding settings ... consider increasing max_num_batched_tokens" on every
start, because each sequence now needs `speculativeTokens+1` decode slots per step rather
than one. A cold 64k prefill is also 32 scheduler steps instead of 16. We take that to keep
the pool, and the warning is expected rather than actionable.

Must stay >= the "Setting attention block size to N tokens" startup line to clear the
assert `--mamba-cache-mode align` makes. That line tracks speculative depth — measured 1568
at K=0 and 1600 at K=3 on this model — so 2048 clears 1600 by 448 tokens, which is thinner
margin than 4096 had. Re-read it after any `speculativeTokens` change rather than assuming.

Read the pool from the startup line or `vllm:cache_config_info`, never from an
interpolation, and only from a clean start: peak-activation profiling measured 1.03 and
3.12 GiB on identical configs minutes apart, so a startup racing another engine's teardown
reports a pool 40% too small.

### vllm.speculativeTokens = 3 (MTP)

3 is what recipes.vllm.ai suggests for this model's MTP head, and it measured 3.04 accepted
tokens per decode step here — on a stack that is 93% decode-bound, which is why removing it
doubled TPOT from 9.98 ms to 18.72 ms.

"Draft-token rollback cannot restore a mamba recurrent snapshot" was the reason given for
the removal in #156 and it is wrong about vLLM. The real exposure is four distinct upstream
defects, all of them gated on speculative decoding being on — prefix caching alone is not
exposed to any of them, which is why it stays on unconditionally and is **not** the next
thing to try if corruption returns. Full M1-M4 catalog, patch status and field evidence:
`docs/ninfer-vs-vllm-2026-09-03/03-mtp-prefix-cache-correctness.md` and
`05-patch-efficacy.md`.

What it costs, measured on the first boot that survived: the pool goes 211,911 -> 120,546
tokens at an unchanged 0.95, i.e. -43%. Not the draft head, which is nearly free (weights
21.97 -> 22.01 GiB) — it is the mamba state, 2+P pages per request becoming 5+P across three
groups, because `num_speculative_blocks == speculativeTokens`. So this number is a KV lever
as much as a speed one, and 3 -> 2 gives a page per request per group back.

Whether that trade is worth taking is an open measurement, not a guess: the first probe
reported per-position acceptance of 0.667, 0.333, 0.333, which would make positions 2 and 3
nearly free to give up — but that was 6 drafts. Read
`vllm:spec_decode_num_accepted_tokens_total / _num_draft_tokens_total` over real traffic
against the 67.9% this stack measured pre-#156 before touching it.

### vllm.enablePrefixCaching = true

Redundant since #50991 turned prefix caching on by default for mamba models in 0.28.0, and
kept explicit anyway: it documents intent and survives a default flip in either direction.
It is the reason prefill is nearly free here — 82.2% of prompt tokens are cache hits — and
no upstream mechanism makes it a corruption suspect on its own. If corruption returns,
`speculativeTokens` comes out first and this stays.

It survives MTP, which was the open question this whole change rested on. Startup logs a
warning that "prefix-cache reuse across requests will be disabled" because no KV group can
be annotated as the draft group; it fires on `use_eagle()` regardless of
`disable_eagle_block_drop` and, for us, it is wrong. Measured 2026-09-04, MTP on, two
identical 30,058-token requests: the second served 28,800 tokens from cache, 95.8%, the
miss being exactly the trailing partial block (30,058 = 18 x 1600 + 1,258). Trust that
number over the warning, and re-run the probe rather than the warning after any engine
bump.

## `nixos.nix` — the nightly image pin

Full rationale (why a nightly SHA and not a release tag, which upstream fixes it carries,
what M2 remains unpatched, the rollback order and why it matters) is in
`docs/ninfer-vs-vllm-2026-09-03/06-mtp-reenable-spec.md` §3.1 and §7.3. `nixos.nix`
keeps a short version and a pointer here; this doc does not duplicate it further.

**Two caveats that live only here.** First, the image is pinned by tag, not by
digest, so it is only as good as upstream not re-pushing that nightly tag. That
is a deliberate stopgap until v0.29 ships, not an oversight - the manifest
digest is recorded in the module comment for manual comparison. Second, calibrate the
confidence in #50729: the upstream 12/5000 -> 0/5000 and 16/288 -> 0/288 counts
are 0.27.1-vs-nightly comparisons carrying hundreds of other commits, not
controlled single-PR measurements (see `05-patch-efficacy.md` rows E2/E3, rated
"Moderate"). `06` §3.1 states the 12/5000 result flatly and, before this was
corrected, asserted that a nightly tag is immutable.

## `vllm-service.nix` — the MTP flag pair

`disable_eagle_block_drop` and `--no-async-scheduling` are explained mechanism-by-mechanism
in `docs/ninfer-vs-vllm-2026-09-03/06-mtp-reenable-spec.md` §3.3 and §4, with the M2/M4
cross-references in `03-mtp-prefix-cache-correctness.md`. The in-file comment carries only
the one-clause-per-rollback structure and a pointer here.
