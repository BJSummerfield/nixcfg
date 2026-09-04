# VERDICT — NInfer vs. vLLM 0.28.0 on Qwen3.8-27B-NVFP4, RTX 5090

Agent V1, 2026-09-03. Synthesis of `01-baseline-vllm.md` (S1, measured),
`02-ninfer-architecture.md` (R1, source read at NInfer HEAD `a140e7ae`),
`03-mtp-prefix-cache-correctness.md` (R2, correctness), `04-performance-projection.md`
(R3, projection). Everything else in this directory is audit trail.

**Nothing was built and nothing was run.** No NInfer binary exists on any machine we own,
no `.ninfer` artifact exists for our weights, and nobody has run this engine on our
traffic. Every NInfer figure below is a projection from their published numbers and their
source constants.

---

## 1. The three answers

### Q1 — Is NInfer's batching better than what we run?

**No. It is worse at our context length, for a structural reason, and the reason is not
the scheduler.**

NInfer's scheduler is in several ways the better design: continuous batching rebuilt at
every decode boundary, strict FIFO with head-of-line protection and a *proof-carrying*
backfill (`prove_persistent_backfill`) that admits a short request past a blocked long one
only with a proof it cannot delay the head, and no preemption at all — against our measured
**0.125 preemptions/request** on vLLM (S1 §6). That part is genuinely better engineering.

It loses anyway, on admission accounting. NInfer **reserves `prompt + max_tokens` at
admission** and holds it to completion; vLLM allocates KV blocks **on demand**. pi's clamp
makes our per-turn entitlement a constant **94,208 tokens** for any turn over ~61k input —
44% larger than the ~65,500 tokens a turn actually touches (R3 §1.1). So:

| | Pool | Per-request claim | Concurrent pi turns |
| --- | ---: | ---: | ---: |
| vLLM (measured-ours) | 211,911 tok | 65,500 on demand | **3** (`maxNumSeqs` binds; pool would allow 3.2) |
| NInfer C=4, fp8 KV (inferred) | ~217,000 tok | 94,208 reserved | **2** |
| NInfer C=8, fp8 KV (inferred) | ~180,000 tok | 94,208 reserved | **1** — starts, then serializes |

`--max-concurrency 8` is **unreachable at our context length under every KV dtype NInfer
offers** (R3 §3.2). Its own StateImage allocation (2 × 146.8 MiB per lane) shrinks the pool
below two entitlements. Their published C=8 / 5.33× row does not apply to this stack and
should not appear in any comparison. Neither should the C=4 / 2.83× makespan figure: it is
a closed-loop benchmark at pinned occupancy 4, and **our time-averaged occupancy is 0.82
requests** (measured-ours: 40,373 s inference ÷ 49,463 s uptime).

The honest framing is **3 vs. 2**, not 2.07 vs. 8. `kv_cache_max_concurrency = 2.069` is
vLLM's own worst-case self-report (pool ÷ `maxModelLen`), not what it achieves on 64k turns.

One more structural loss: **prefill and decode never co-run.** NInfer's worker issues one
unit per iteration and alternates (`scheduler.h:239-246`), and prefill is single-lane. vLLM
fuses prefill chunks and decode tokens into one forward pass at
`--max-num-batched-tokens 4096`. See §7 for the disagreement over how much this costs.

### Q2 — Would the MTP × prefix-cache bug exist on NInfer?

**No. Structurally immune to the design-level hazard — but the immunity is a claim about
source, not about a running system.**

R2's mechanism correction matters and is the first thing to internalise: **vLLM does snapshot
recurrent state per verify position.** It allocates `num_speculative_blocks` extra mamba slots
and selects the committed one by accepted count. The corruption is not a failure to snapshot;
it is four distinct defects sharing one symptom — a snapshot **mislabelled** on publication
(#51113, fixed in 0.28.0), **left reachable** when it should have been dropped
(#43650/#48375, open), **corrupted by an overlapping conv-state copy** (#50729, merged,
*absent from 0.28.0*), or **selected with another request's accepted count** (#51571/#53919,
open).

NInfer cannot produce any of the first three. Its verify pass is
`gated_delta_net_replay_record`, whose op contract reads "*without modifying any state*" — it
is passed source state slots and no destination, and emits raw transition records instead.
Rejection is `commit_columns = 0`, "a strict no-op for the row: no record or state is read."
There is no poisoned state to publish because no draft-position state is ever written.
Independently there is **no per-block state hash to mislabel**: a reusable prefix is one
immutable whole `StateImage` bound to one exact token frontier, and their own doc is explicit
that digests are a shortlist that "does not prove a hit."

Three caveats R2 states and I am not softening:

1. vLLM's design was also sound in outline; it failed on implementation details. NInfer has
   no independent deployment evidence.
2. The fourth mechanism (M4, host/device race on accepted counts) is an implementation race.
   NInfer's structure is far less exposed — single stream, synchronous round boundary,
   per-row base revalidation that throws — but R2 did not trace
   `MtpDecodeEgress::accepted_drafts` to the host read and does not claim immunity.
3. **No test in the NInfer repo asserts that the cache-hit path produces the same output as
   the cache-miss path.** Their end-to-end `anthropic-prefix-regression` scenario builds
   exactly the A→B→A traffic shape that caught the vLLM bug, on our exact model, and then
   checks *reuse accounting* instead of output. That is precisely the property whose absence
   let vLLM ship four of these.

And separately: **the config we run right now is not exposed to this bug class.** With MTP
off, M1 is fixed in 0.28.0, M2's `drop_eagle_block` branch is inert, M3 has no shift copy to
corrupt, and M4 has no accepted counts to race on. Three independent upstream reporters
corroborate that no-MTP + prefix-caching is clean.

### Q3 — Estimated speeds

Prefill is a wash. Decode is NInfer's real win, and it is entirely an MTP win. TTFT is a wash
at the median and probably worse in the tail. Caching is the risk.

- **Prefill:** ~5,000–5,500 tok/s projected vs. our measured **5,378.8 tok/s**. ±5%. The
  highest-confidence row in the study, and it says "no change."
- **Decode without spec decode:** 60–70 tok/s projected vs. our measured **51.2–53.4 tok/s**.
  +15–30%.
- **Decode with MTP3:** 135–180 tok/s projected. That is 2.6–3.4× what we run today — but
  only 1.35–1.8× the **~100 tok/s** we measured on 09-01 *with* MTP on vLLM.
- **TTFT:** median 0.5–1.2 s projected vs. measured **≈0.49 s**; mean 2.5–10 s straddling our
  measured **3.300 s**; **p95 25–70 s vs. our measured ≈20 s** — worse, driven by single-lane
  prefill, no preemption, and 94,208-token reservations blocking admission.
- **Caching:** projected hit rate **55–85%, bimodal**, vs. our measured **82.2%**. This is
  the least certain number in the study and it is the one that decides the comparison — see §2.

---

## 2. The sharpest number in the study: **h ≥ 0.87 just to break even**

vLLM's prefix cache is a partial-match radix over 1,568-token blocks: a miss costs only the
**unmatched suffix**. NInfer's is a catalog of whole-continuation checkpoints at exact token
frontiers: a miss costs the **whole prompt**. Their doc states this as a design choice — "when
only tokens match, or only KV bytes or pages match, what is missing is a complete continuation,
not a partial cache hit."

So the two hit rates are not comparable quantities, and the honest common unit is computed
prefill tokens per request. Ours, measured: **9,726** (15,347,999 ÷ 1,578) at h = 0.822.
NInfer's, at hit-delta ≈ 3,000 and mean prompt 54,765 (R3 §2.5):

| NInfer *h* | Computed tokens/request | vs. our measured 9,726 |
| ---: | ---: | --- |
| 0.55 | 26,000 | 2.7× worse |
| 0.70 | 18,500 | 1.9× worse |
| 0.85 | 10,800 | 1.1× worse |
| **0.87** | **9,700** | **break-even** |
| 0.95 | 5,600 | 1.7× better |

**NInfer must clear an exact-frontier hit rate of 0.87 merely to compute the same number of
prefill tokens per request that vLLM already computes at 0.822.** Not to win — to tie.

What to do with that: it converts a vague worry into one measurable, cheap gate. Run a replay
of ~200 real pi turns through NInfer with `--request-log-jsonl` and read
`prefix_cache_hit_tokens ÷ prompt_tokens` across the population (§9, probe A). No throughput
measurement, no A/B, no statistics. If that number comes back below 0.87, NInfer is doing
*more* prefill work than vLLM on our traffic, and its decode advantage has to pay that back
before it pays anything else. If it comes back above 0.95, NInfer's caching is a genuine win
and the study's most pessimistic column disappears.

The distribution is **bimodal, not Gaussian**: it hinges on whether pi's re-render of assistant
tool-call JSON reproduces the model's emitted tokens exactly. If it does not, and the
`private_turn_closure` fallback also misses, h is ~10% rather than "the low end of 55%." R1
found NInfer HEAD commits `a140e7ae "preserve exact agent prefix reuse"` and
`719d56ef "preserve structured tool call intent"` landed **on the day of this study** in that
exact path — reassuring that it is maintained, cautionary that it was broken until 2026-09-03,
and no evidence either way about pi's specific renderer.

---

## 3. Side-by-side

Provenance: **measured-ours** = S1's scrape or the 09-01 measurements · **published-theirs** =
NInfer's own docs (their box, their fixtures, INT8 KV, prefix reuse **disabled** in every
published campaign) · **inferred** = R3's arithmetic over their source constants. NInfer column
assumes `--max-concurrency 4`, `--kv-dtype fp8`, `--max-context 102400`, MTP3 on.

| Metric | vLLM (measured-ours) | NInfer (projected range) | Provenance of the NInfer figure | Confidence |
| --- | ---: | ---: | --- | --- |
| Per-stream decode, no spec decode | **51.2–53.4 tok/s** | **60–70 tok/s** | published-theirs 65.7 ±0.8 @64,512 ctx, discounted | High |
| Per-stream decode, MTP on | n/a today; **~100 tok/s** on 09-01 with MTP | **135–180 tok/s** | inferred from their round-cost model | Medium |
| TPOT | **18.72 ms** ITL / 19.55 ms req | **14.3–16.7 ms** MTP0 · **5.6–7.4 ms** MTP3 | inferred (reciprocal) | Medium / Med-low |
| Prefill compute rate @64k | **5,378.8 tok/s** | **5,000–5,500 tok/s** | published-theirs 5,297.9 ±259 @64,512 | High — a wash |
| Prefill effective rate | **30,286 tok/s** | **15,000–36,000 tok/s** | inferred; the whole range is *h* | Low |
| Prefix-reuse hit rate | **82.2%** (partial-match radix) | **55–85%**, bimodal | inferred; exact-frontier scheme | Low — the pivot |
| Computed prefill tokens/request | **9,726** | **9,000–28,000** | inferred; break-even at h = 0.87 (§2) | Medium |
| TTFT median | **≈0.49 s** | **0.5–1.2 s** | inferred | Medium |
| TTFT mean | **3.300 s** | **2.5–10 s** | inferred | Low |
| TTFT p95 | **≈20 s** | **25–70 s** | inferred; single-lane prefill + no preemption | Low |
| Effective concurrency at 64k turns | **3** | **2** | inferred from their source constants | High |
| `--max-concurrency 8` usable | n/a | **No** — delivers 1 concurrent turn | inferred | High |
| Aggregate decode at achievable batch | **~104 tok/s** at 2 streams | **122 tok/s** MTP0 · **270–330** MTP3 | inferred | Medium |
| Preemptions/request | **0.125** | **0** (never preempts) | published-theirs (design) | High |
| Requests failing on queue deadline | **1.1%** exceed 30 s queue | **2–8% would 503/504** at default `--pending-timeout-ms 30000` | inferred | Medium |
| Their headline speedups (C=4 2.83×, C=8 5.33×) | — | **Inapplicable** — our occupancy is **0.82 requests** | inferred | High |

---

## 4. What NInfer buys, and what it costs

### Buys

1. **MTP and prefix caching at the same time, safely** (§1 Q2). This is the only thing on the
   list vLLM cannot currently give us, and it is worth 2.6–3.4× decode against today's stack.
2. **Per-request telemetry that is a strict superset of our `/metrics` scrape**:
   `prefix_reuse_path`, `prefix_cache_hit_tokens`, `computed_prefill_tokens`, FIFO
   `queue_wait_seconds`, a host-phase split of exposed time, and `tool_call_parse` fallback
   reasons — a text-free classification of malformed tool calls, exactly the failure mode we
   have been chasing on vLLM and cannot attribute. Schema v20, six event types.
3. **A pinned-host checkpoint tier** (`--host-kv-mib`) with no vLLM equivalent for hybrid
   models: an inferred 60–120 ms restore against a 12.3 s cold prefill.
4. **Anti-starvation admission**: head-of-line protection plus proof-carrying backfill, and
   zero preemptions against our measured 0.125/request.
5. **Native top-level `reasoning_effort`** (`none|low|medium|xhigh` executable) and two KV
   dtypes we have no access to (`nvfp4`, `k8v4`), one of which is the only lever that moves
   concurrency (2 → 4 turns at C=4) — and which is two days old and unbenchmarked by anyone.

### Costs

1. **Build from source; no published OCI image.** A `Dockerfile` now exists in-tree
   (two-stage, `nvidia/cuda:13.1.2-devel-ubuntu24.04`), which removes the "nix build OOMs on
   32 GB" objection — but the README instructs `docker build --tag ninfer:local .`, i.e. you
   build it. There are no releases and no tags, so you pin a commit SHA. The build rejects any
   CUDA arch other than `sm_120a` and needs CUDA 13.1+, CMake 3.28+, C++20, Ninja, FFmpeg dev,
   libcurl ≥ 7.85. `pkgs ? ninfer` re-verified **false** today.
2. **A separate weight artifact.** `neroued/Qwen3.8-27B-nvfp4-NInfer`, a single
   `qwen3_8_27b_nvfp4.ninfer` container — derived from the `unsloth` weights we already have
   but **not loadable from them**. Plan for a second full copy on disk plus new `models.nix`
   entries with a new repo, file list and sha256. Whether the in-tree converter can rebuild it
   from our local files is **not determinable** — R1 did not read the converter.
3. **A `settings.nix` change — narrower than the prior review said, but real.**
   `chat_template_kwargs` accepts exactly `enable_thinking` and `preserve_thinking`;
   `reasoning_effort` there is rejected with HTTP 400 `chat_template_option_not_supported`.
   Our `modules/pi-coding-agent/settings.nix` puts both inside `chat_template_kwargs`. The fix
   is to move `reasoning_effort` to top level; `enable_thinking` may stay, and the two may
   coexist as long as they do not contradict. (The prior review's stated reason — "only
   `preserve_thinking` is accepted", "sending both returns `conflicting_template_option`" —
   was wrong; the conclusion survives.)
4. **No structured outputs, no constrained decoding, no logprobs, no strict tool mode.**
   `grammar` / `structured_outputs` / `guided_*` are rejected by name with
   `constrained_decoding_not_supported`. Also rejected: nonzero `logit_bias`, requested log
   probabilities, `strict:true`, required or named `tool_choice`, `parallel_tool_calls:false`
   with tools, `n > 1`, any `response_format` other than `{"type":"text"}`.
5. **Queue defaults would fail 2–8% of our requests.** `--pending-timeout-ms 30000` is an
   *absolute* deadline that starts before preparation; 1.1% of current-soak requests already
   queue past 30 s on vLLM and the 09-01 soak reached 480 s, and NInfer's waits will be longer
   (2 concurrent instead of 3, single-lane prefill, one admission per boundary, no preemption).
   Anthropic-endpoint remapping turns these into **504** and 429 into **529**. This is a config
   trap, not an architectural limit — `--pending-timeout-ms 600000 --max-pending-requests 48`
   removes it — but it must be in the deployment recipe or the first fan-out burst surfaces in
   pi as a wave of tool failures.
6. **Prefill and decode never co-run.** 5–15% aggregate decode tax on the mean; on a cold 64k
   turn a co-running decode stream advances ~180 tokens instead of ~2,300. Cold prefills
   *serialize* across lanes, so three cold 25k turns arriving together put the third ~15–20 s
   from its first token. `--prefill-chunk` is settable down to 128 but the trade curve is
   unmeasured by anyone.
7. **Maturity.** Repo created 2026-06-26. **3 contributors** (966 / 7 / 1 commits), 974 commits,
   1,272 stars, **0 releases, 0 tags, no CI at all** (no `.github/` directory), no stability
   statement anywhere. On the other side: 107 test files under CTest and unusually detailed
   maintainer design documents. Read: young, single-maintainer, high-velocity, not unserious —
   but bus factor 1, no machine-verified build health, and a CLI/API contract that
   demonstrably moves (five drift items landed in the 72 hours before this study).

---

## 5. Go / no-go

> ## **NO-GO.** Do not migrate. Do not build the bench yet either.

The case for NInfer rests on one load-bearing claim: it restores MTP-class decode speed that
vLLM cannot safely give us. Everything else on the "buys" list is nice and none of it is worth
a from-source engine with bus factor 1, no CI, no tags, a second copy of the weights, and a
projected *loss* on concurrency, TTFT tail and — below h = 0.87 — prefill work.

And that one claim is not yet established as exclusive, because **the cheapest test of whether
vLLM can have MTP back has not been run.** Two vLLM-side experiments dominate this entire
comparison and neither requires NInfer to exist (§6).

**The flip condition, stated as a conjunction because either half alone is insufficient:**

> Migration becomes worth benching when **(a)** MTP is demonstrated to be unsafe or
> unobtainable on vLLM — the parser confound is resolved *and* an image containing #50729 has
> been tried and still corrupts, or no such image is obtainable within a quarter — **and (b)** a
> replayed-pi-session probe measures NInfer's exact-frontier hit rate at **h ≥ 0.87**.

Why both: with MTP back on vLLM, NInfer's decode edge collapses from 2.6–3.4× to 1.35–1.8× —
not enough to buy the costs in §4, at any hit rate. And with h < 0.87, NInfer computes 1.1–2.7×
our prefill tokens per request, which its decode edge has to pay back before it pays anything.

Order of operations: (a) first. It is cheaper, it is about a stack we already run, and it can
close this question outright.

---

## 6. The MTP-restoration experiment is blocked on an artifact that does not exist

R2 §6 and R3 §7.4 both recommend "bump to v0.28.1, re-enable MTP, ~1 hour, moots the
migration." **The substance is right. The cost is wrong, and the "one hour" figure should not
be repeated.** Verified against the GitHub API on 2026-09-03:

- vLLM issue **#47194 is still OPEN**.
- PR **#51113 is contained in v0.28.0** (confirmed via the compare API).
- PR **#50729 is NOT in v0.28.0** — the tag is 2 commits behind the merge, status "diverged".
  It **is** contained in the git tag **`v0.28.1rc0`**. (R2 wrote "0.28.1rc1" in one place,
  quoting a reporter; the tag that exists is `v0.28.1rc0`.)
- **There is no v0.28.1 release.** The latest GitHub release is v0.28.0, 2026-08-26.
  `v0.28.1rc0` exists only as a git tag.
- **Docker Hub has no image for any 0.28.1 tag** — only the twelve `v0.28.0*` variants.

That last point is the whole problem. `modules/local-llm/nixos.nix:45` consumes an upstream OCI
image **by design**: "nix build OOMs on 32GB and nixpkgs lags upstream." Testing #50729
therefore requires one of:

| Option | Cost | Notes |
| --- | --- | --- |
| **Wait for an upstream 0.28.1 image on Docker Hub** | zero effort, unbounded latency | The declarative path. A one-line `vllmImage` bump the day it appears. Nobody controls when. |
| **Build vLLM from source** | high; contradicts the reason the pin exists | This is precisely what `nixos.nix:45` exists to avoid. |
| **Run `v0.28.1rc0` in a scratch container off the declarative path** | ~a day, manual, throwaway | Build the rc image by hand on redtruck, outside nixcfg, purely to answer "does MTP stop corrupting." Answers the question without committing the fleet to an rc. |

Meanwhile, **the free experiment that nobody has run**: commit `1b12ba9` changed two things at
once — it removed MTP *and* swapped `toolCallParser` from `qwen3_coder` to `qwen3_xml`. Our own
`models.nix` comment says `qwen3_coder` "emits unbounded garbage on long inputs containing a
tool call," and upstream #47194's reporter also ran `qwen3_coder`. **A clean post-#156 soak
cannot distinguish "MTP removal fixed it" from "the parser swap fixed it."** Re-enabling MTP on
the *current* 0.28.0 image with `qwen3_xml` retained costs half a day and no new artifacts, and
if it comes back clean, MTP never needed removing and both the 0.28.1 chase and this entire
study's premise are moot.

**Run the parser experiment first.** It is the only item in this document that costs nothing
and could end the question.

---

## 7. Disagreements between agents, unresolved and named

**7.1 — How bad is prefill/decode non-overlap?** R1 §1.1 called it "the single most important
architectural fact for R3's projection" and reasoned that a 12 s cold 64k prefill leaves
co-running decode getting only every other unit — potentially serious. R3 §4 quantified it and
came out much lower: **5–15% aggregate decode tax**, because 82%-style reuse keeps mean computed
prefill in the single-digit thousands, so the engine rarely spends long in prefill at all. Both
are right about different things, and R3 says so: on the *mean* it is a tolerable tax; on the
**p95 TTFT it is the dominant term**, and it is exactly the effect no NInfer benchmark can show
(their MTP0 campaign is one request at a time; their saturation campaign uses 293-token prompts
where prefill is 0.03 s). **Resolution:** R3's magnitude is conditional on R3's own hit-rate
estimate. If h lands in the bimodal low mode, mean computed prefill triples and R1's worry
becomes the correct one. Probe C in §9 measures it directly.

**7.2 — C=4 or C=8? NInfer's own docs contradict each other.** `docs/performance.md`'s
corpus-makespan table puts the Qwen3.8-27B NVFP4 optimum at **C=4, 2.83×, ~58% acceptance**.
`README.md`'s newer "Concurrent MTP3 decode" saturation table puts the same model at **C=8,
5.33×, ~46% acceptance** — near-linear scaling, the opposite shape. The Qwen3.8 row appears in
the README and **not** in `docs/performance.md`'s own saturation section, which looks like an
incomplete doc update. R1 marked it **[cannot determine]**. **R3 resolved it by making it
irrelevant:** C=8 delivers *one* concurrent pi turn at our reservation size, so neither
multiplier is reachable, and both are closed-loop benchmarks against our 0.82 time-averaged
occupancy anyway. The doc contradiction stands unresolved upstream; its decision relevance is
nil. Probe B in §9 confirms in ten minutes.

**7.3 — Is prefix caching a suspect on the running stack?** `models.nix:124-126` says "If
corruption outlives the MTP removal, this flag is the next thing off." R2 §4 checked all four
upstream mechanisms and found **none of them reaches a no-MTP configuration**, with three
independent reporters corroborating that prefix caching without MTP is clean. **R2 is right and
the comment should change** (§8). Turning prefix caching off would cost us the measured 5.6×
gap between 30,286 tok/s effective and 5,378.8 tok/s compute prefill, to address a hazard with
no known mechanism. If corruption outlives #156, the evidence points at the tool parser.

**7.4 — Could not resolve: is NInfer's ReplaySSM empirically correct?** R1 read the design and
its implementation; R2 read the kernels and the fold contract and found the guarantee is
structural (verify and fold share the same `apply_gdn_transition` device function, so bitwise
equality is a property of shared code rather than of two implementations agreeing). Neither
built it. R2's §3.6 gap is the honest statement: **no test in the repo asserts hit-path output
== miss-path output.** Probe D in §9 is the only thing that would resolve it.

---

## 8. Corrections this study establishes for the repo's own documentation

Listed, not applied — this study changes no config and edits nothing outside this directory.

1. **`modules/local-llm/models.nix:117-122`** — the stated mechanism is factually wrong.
   "Draft-token rollback cannot restore a mamba recurrent snapshot" does not describe vLLM: it
   *does* snapshot recurrent state per verify position and select by accepted count. Replace
   with R2 §1.6's text, which names the four defects and their actual status.
2. **`modules/local-llm/models.nix:124-126`** — "If corruption outlives the MTP removal, this
   flag [`enablePrefixCaching`] is the next thing off" has no supporting upstream mechanism
   (R2 §4). The next suspect should be the tool parser, given commit `1b12ba9` changed both at
   once (§6).
3. **`modules/local-llm/nixos.nix:47-62`** — the MTP re-enable gate is stated as "a tag that
   closes those issues." The accurate gate is narrower and names an artifact: **an upstream OCI
   image containing #50729**, which is merged, absent from v0.28.0, present in git tag
   `v0.28.1rc0`, and **not published as any Docker Hub image or GitHub release**. Also worth
   recording: #47194 is still open, and #43559 was auto-closed one second after #51113 merged,
   so its closure carries no post-fix verification.
4. **`docs/local-llm-review-2026-09-01/03-ninfer.md`** — superseded by this directory; mark it
   so. Its specific errors, for anyone who reads it anyway:
   - **Wrong model's numbers.** "prefill 11,192 → 2,511 tok/s, TTFT 693 ms → 103.8 s" are
     **Qwen3.6-27B** figures. Ours are 8,340 @7,680 → **5,297.9 @64,512 (12.28 s TTFT)** →
     3,545 @130,048 → 2,203 @260,096.
   - **Never noted that every published NInfer campaign ran with prefix reuse *disabled*.**
   - **"Only `preserve_thinking` is accepted" is wrong** (`enable_thinking` is accepted on Chat
     Completions), and **"sending both returns `conflicting_template_option`" is overstated** —
     that error fires only on an actual contradiction. The `settings.nix` conclusion survives,
     the reason does not.
   - Request-log schema is **v20, not v18**; three additional reuse paths exist.
   - `--kv-dtype` now has **five** modes, not three (`nvfp4`, `k8v4` added 2026-09-01).
   - "Easy to misconfigure into something that silently truncates" is wrong for
     `--kv-capacity`: illegal values **throw at startup**, and an oversized prompt is
     **rejected** with `ContextLengthExceeded`. The trap is loud, not silent.
   - "No OCI packaging at all" is now false — a `Dockerfile` exists in-tree; no *published*
     image, so the operational statement survives.
   - "Maturity is unknown" is superseded by hard numbers (§4, cost 7).
   - Its premise "our stack does 97.9 tok/s at 67.9% acceptance, better than NInfer" is **void**
     post-#156.
   - Acceptance is **37–91% by workload category**; any single "NInfer gets X%" figure is
     unusable.
5. **`00-PLAN.md:36`** framed the baseline as "`kv_cache_max_concurrency` 2.07 against
   `maxNumSeqs = 3`." That figure is vLLM's worst-case self-report (pool ÷ `maxModelLen`); at
   our actual ~65,500-token turns the pool holds **3.2**, so `maxNumSeqs = 3` is what binds.
   The fair comparison against NInfer is **3 vs. 2**.

---

## 9. Bench recipe, for when the flip condition fires

Do not run this until §6's two vLLM experiments have. Everything below assumes a build, which
is the first real cost.

**Setup.** Clone at a pinned SHA (`a140e7ae` or later — there are no tags), then
`docker build --tag ninfer:local .` against the in-tree two-stage Dockerfile. Fetch the
artifact: `hf download neroued/Qwen3.8-27B-nvfp4-NInfer qwen3_8_27b_nvfp4.ninfer --local-dir
models` — a second full copy of the weights, ~20 GiB. Do **not** put any of this in nixcfg yet.

**Serve flags** (spellings from R1's read of `docs/cli.md`/`docs/serving.md` at that HEAD —
verify against `--help`, the CLI contract moves):

```
ninfer-serve --model models/qwen3_8_27b_nvfp4.ninfer \
  --max-context 102400 --kv-capacity auto --kv-dtype fp8 \
  --max-concurrency 4 --prefill-chunk 1024 \
  --spec mtp --draft-tokens 3 \
  --max-pending-requests 48 --pending-timeout-ms 600000 \
  --host-kv-mib 32768 --host-state-slots 24 --max-private-continuations 24 \
  --request-log-jsonl /var/lib/ninfer/requests.jsonl --log-stats-interval-ms 5000
```

The two timeout/queue flags are **mandatory**, not tuning: defaults would 503/504 an estimated
2–8% of our requests. `--host-kv-mib 32768` requires redtruck to have the RAM — **not
determinable from this repo**; check before assuming the tuned hit-rate branch is reachable.
Client side, `reasoning_effort` must move to top level or every request 400s.

**Probe A — hit rate. Run this first; it can end the bench.**
Replay ~200 real pi turns (a captured session, in order, same `reasoning_effort`). Capture from
the JSONL: the histogram of `prefix_reuse_path` over `{root, private_endpoint,
private_turn_closure, private_response_replay, private_long_anchor, shared_stable_prefix}`, and
`Σ prefix_cache_hit_tokens ÷ Σ prompt_tokens`. No timing needed.
**Decides:** h ≥ 0.87 → proceed. 0.55–0.87 → NInfer computes more prefill than vLLM; proceed
only if the decode win covers it. < 0.55, or `root` dominating → **stop, no-go is final.**

**Probe B — the C-sweep.** Start at `--max-concurrency 2, 4, 8` with `--max-context 102400`,
read back the resolved `kv_capacity`, then fire a 4-request burst of real 64k turns and watch
`throughput.running` / `waiting`. Ten minutes, no client timing.
**Decides:** whether C=4 really gives 2 concurrent turns and C=8 really gives 1. If C=8 gives
≥ 3, R3 §3.2's back-solved 1.95 GiB workspace constant is wrong and the concurrency verdict
needs redoing. Repeat with `--kv-dtype nvfp4` — the only lever that moves this — and eyeball
output quality at 64k, because nobody has benchmarked it.

**Probe C — the non-overlap tax.** Issue one cold 64k request while one stream is decoding;
read `engine_timing.device_wait_exposed_seconds` on the *decoding* request.
**Decides:** disagreement 7.1. Expect the decoding stream at ~7–9% of solo rate during the
prefill. Do not sum `engine_timing` across concurrent requests — their docs forbid it; use
`throughput.host_work` as the aggregation authority.

**Probe D — the determinism probe. This is the one their test suite does not run.**
At temperature 0 with `--spec mtp --draft-tokens 3`: send prompt A, then a divergent prompt B,
then prompt A again, and assert the third response is **token-identical** to the first. Repeat
the whole arm with `--no-prefix-reuse` and assert both arms agree. Their
`anthropic-prefix-regression` scenario already builds this traffic shape on our exact model and
checks accounting instead of output.
**Decides:** whether R2's structural-immunity verdict survives contact with a running binary.
This is the probe shape that caught the vLLM bug when unit tests did not. **A failure here is
disqualifying regardless of every other number in this document.**

All four run off the same build and the same artifact. None needs a statistically clean A/B —
they are structural checks, and each can falsify a load-bearing claim on its own.

---

## 10. One cheap lever, noted and not recommended

R3 §3.3: pi's `maxTokens` of 32,768 makes the per-turn NInfer reservation **94,208** tokens.
Dropping it to ~4,096 cuts the reservation to ~68,300 and raises NInfer from **2 to 3**
concurrent turns at C=4 (or 4 → 5 with nvfp4 KV).

**It does nothing on vLLM**, which allocates KV on demand and never reserves the unused output
budget — which is exactly why our measured concurrency is 3 today with no such change.

So: worth knowing, because it removes NInfer's concurrency deficit for a one-line config change
if we ever bench it. **It is not a reason to change anything today.** Under the current engine
it buys zero and it would cap output length for no benefit — and `models.nix:130-136` already
records what happens when a token budget gets edited in place.
