# NInfer architecture — how it actually works

Agent R1. Read date **2026-09-03**.

**Source read:** full clone of <https://github.com/Neroued/ninfer> at
HEAD = `a140e7ae82a11ed2f370a4d8f2cc16268a3790b8`
("fix(engine): preserve exact agent prefix reuse", 2026-09-03 21:50:51 +0800, author `Neroued`).
The repo was cloned to `/tmp/ninfer` and read as source, not through the GitHub web UI. Paths below
are repo-relative; prefix them with the repo root to reproduce.

Every claim below is one of:
- **[src]** quoted from source at that HEAD, with file:line;
- **[doc]** quoted from an in-repo document at that HEAD;
- **[api]** returned by the GitHub REST API on 2026-09-03;
- **[inference]** my reading, explicitly labelled;
- **[cannot determine]**.

Where **[doc]** and **[src]** disagree I say so and prefer **[src]**.

---

## 0. Executive answers

| Question | Answer |
| --- | --- |
| Batching model | **Continuous batching at decode-round granularity**, over a startup-fixed set of `C = --max-concurrency` lanes. Not static/lockstep: a finished lane is removed at the next boundary and the batch is rebuilt without an empty row. |
| Prefill/decode co-run | **No.** One worker thread issues exactly one unit per iteration — control batch, *or* one lane's prefill chunk, *or* one decode round. Prefill and decode strictly alternate. |
| Chunked prefill | **Yes**, `--prefill-chunk` default 1024, must be a nonzero multiple of 128. But only **one lane at a time** may own prefill. |
| `--max-concurrency` | **Both** a startup allocation and a scheduler cap, and it is a hard compile-time-bounded 1..8. |
| Request N+1 at capacity | **Queues** in a bounded FIFO. Never preempts. 429 when total lifetime capacity `C + max_pending_requests` is exceeded; 503 on the absolute `pending-timeout-ms` deadline. |
| Prefix reuse | **Whole-continuation checkpoints at exact token frontiers**, not a radix/block cache. Six named paths. Requires exact token/position/media/mode identity. |
| Does the prefix cache store recurrent state? | **Yes.** A checkpoint's `StateImage` is literally `{linear conv state, linear recurrent state, continuation hidden, optional DFlash local KV}`. |
| Spec-decode rollback | **There is no rollback.** Recurrent state is never speculatively advanced. Verify runs in `RecordForReplay` mode and only the accepted prefix is folded in afterwards. `commit_columns == 0` is a strict no-op. |

---

## 1. Batching and scheduling

### 1.1 The execution loop is single-threaded and issues one unit at a time

`src/runtime/engine/engine_core.h:1925` `worker_loop()`. Per iteration it takes
`execution_mutex_`, then in order:

1. `expire_pending_requests()` — retires timed-out waiters;
2. optionally `try_admit_one()` — at most **one** admission per boundary;
3. if a **control** batch is ready, run it and `continue`;
4. otherwise `scheduler_.choose_execution(...)` picks `Prefill`, `Decode`, or `Wait`;
5. run exactly that one unit; `continue`.

The selector, **[src]** `src/runtime/engine/scheduler.h:239-246`:

```cpp
[[nodiscard]] ExecutionAction choose_execution(bool have_decode, bool prefill_runnable,
                                               bool previous_unit_was_decode) const noexcept {
    if (prefill_runnable) {
        return have_decode && !previous_unit_was_decode ? ExecutionAction::Decode
                                                        : ExecutionAction::Prefill;
    }
    return have_decode ? ExecutionAction::Decode : ExecutionAction::Wait;
}
```

So when both prefill and decode are runnable the engine **alternates** them one unit at a time.
There is no fused prefill+decode step. This is materially different from vLLM's chunked-prefill
scheduler, which packs prefill chunks and decode tokens into the *same* forward pass.

Prefill is furthermore **single-lane**. `src/runtime/engine/scheduler.h:259-263`:

```cpp
void set_prefill_lane(std::uint32_t lane) {
    if (prefill_lane_) { throw std::logic_error("multiple requests own staged prefill"); }
    prefill_lane_ = lane;
}
```

and `run_prefill_step` (`engine_core.h:1380`) advances exactly `slots_[*prefill_lane]` by one chunk
via `instance_.program->advance_prefill(...)`.

**[inference]** Consequence for our workload: with 56:1 input:output and ~64k input turns, a cold
64k prefill at ~5,300 tok/s (their own MTP0 number, §7) is ~12 s of wall time during which decode
for other lanes only gets every *other* unit. TTFT and TPOT interact strongly here. This is the
single most important architectural fact for R3's projection.

### 1.2 It is continuous batching, not static batching

**[doc]** `docs/serving.md:935-938`:

> At each decode boundary, every decode-ready request is compacted into one batch and processed by
> one model traversal and, when graphs are enabled, one exact-batch CUDA Graph replay. A request
> joins that batch only after its single-request prefill finishes; when it completes or is
> cancelled, the next boundary rebuilds the batch without an empty row.

**[src]** confirms: `build_round_membership` (`scheduler.h:143`) walks lanes `0..max_concurrency`
each iteration and skips `nullptr`, non-decode-ready, and `capture_pending` lanes, packing the
survivors compactly into `membership.lanes[0..size)`. Requests join and leave independently. There
is **no** notion of a batch running to completion.

The "exact-batch CUDA Graph" claim is backed by startup: graphs are captured per batch size
`1..max_concurrency` (`src/targets/qwen3_6/impl/runtime/layouts_impl.h:405,446,542` all loop
`for (batch = 1; batch <= max_concurrency; ++batch)`), and the graph allowance is
`12 MiB * max_concurrency` (`layouts_impl.h:668`).

### 1.3 `--max-concurrency` is both an allocation and a cap

Hard bound, **[src]** `include/ninfer/types.h:20`:

```cpp
inline constexpr std::uint32_t kMaximumConcurrency = 8;
```

Validated at `src/targets/qwen3_6/impl/runtime/layouts_impl.h:579-581`:
`"max_concurrency must be in [1,8]"`.

It is a **cap**: `engine_core.h:2043` holds
`std::array<std::shared_ptr<Request>, kMaximumConcurrency> slots_{}` and every scheduler walk is
`for (lane = 0; lane < max_concurrency; ++lane)`. `max_concurrency_` is `const` (`engine_core.h:2030`).

It is also a **startup allocation**. At `C = max_concurrency`, startup sizes:

| Resource | Sizing | Source |
| --- | --- | --- |
| Device StateImage slots | `C + device_state_slots` | `layouts_impl.h:96`; `docs/serving.md:818` |
| GDN replay record capacity | `record_capacity = C` rows | `layouts_impl.h:155` |
| KV execution table rows | `table_rows = C` | `layouts_impl.h:122,188` |
| Decode batch capacity | `batch_capacity = C` | `layouts_impl.h:211` |
| CUDA Graph allowance | `12 MiB * C` (or per-batch × C) | `layouts_impl.h:668,681` |
| CUDA Graphs captured | one per batch size `1..C` | `layouts_impl.h:405,446,542` |
| Default `max_private_continuations` | `2C` | `docs/serving.md:822`, `include/ninfer/types.h:127` |
| Default `max_shared_prefixes` | `max(C, 4)` | `include/ninfer/types.h:127` (changed at HEAD, see §9) |

So raising `--max-concurrency` costs GPU memory before any request arrives, and it cannot be
changed without a restart. **[doc]** `README.md`: "GPU residency is fixed at process startup";
"Explicit capacities remain fixed for the process lifetime."

### 1.4 The FIFO, head protection, and non-starving backfill

Admission is a **strict FIFO with head-of-line protection plus a provably-safe backfill**, which is
more sophisticated than the prior review's "bounded pending queue" summary.

`try_admit_one()` (`engine_core.h:1648`):

1. Take the FIFO head. Drop it if cancelled or past `deadline` (→ 503).
2. `inspect_admission(head)`. If `PermanentlyInfeasible` → error
   `ContextLengthExceeded`: `"request reservation exceeds Engine shared KV capacity"`
   (`engine_core.h:1692-1695`). Note this is a **rejection**, not a queue — a request whose
   reservation can never fit is failed rather than parked.
3. If `Ready` or `NeedsTransfer` → `grant_head(...)` and admit. **One admission per boundary.**
4. Otherwise the head is *feasible in isolation but blocked now*. The scheduler opens a
   **protection epoch** over the currently active set (`protect_blocked_head`, `scheduler.h:290`).
5. Only then are `queued.backfill_candidates()` (everything behind the head) considered, and a
   candidate is admitted **only** if `resources_.prove_persistent_backfill(...)` returns a proof
   that it cannot delay the protected head (`engine_core.h:1770-1781`,
   `scheduler.h:316` `qualify_backfill`).

`AdmissionGrant`s are single-use and revalidated at commit (`validate_grant`, `commit_admission`),
so a stale plan throws rather than admitting.

**[inference]** Practical read: short requests can overtake a blocked long request, but only with a
proof of non-interference. This is a genuinely anti-starvation design; vLLM's default scheduler has
no equivalent proof obligation.

### 1.5 What happens at capacity — queue, reject, preempt

**Never preempt.** `README.md` "Capabilities and limits": "no request preemption, priority/QoS,
active-request swapping, weight offload, multi-GPU, or distributed serving." Confirmed structurally:
`worker_loop` has no path that removes a non-cancelled, non-finished request from `slots_`, and
**[doc]** `docs/serving.md:951`: "Admission reserves the full prompt-plus-effective-output page
entitlement through request completion."

The queue bound, **[src]** `engine_core.h:67-69`:

```cpp
max_outstanding_(static_cast<std::size_t>(options.max_concurrency) +
                 options.max_pending_requests),
```

and `engine_core.h:188-190`:

```cpp
if (outstanding_ >= max_outstanding_) {
    throw RequestError(RequestErrorKind::Overloaded, "inference request queue is full");
}
```

`outstanding_` counts **everything alive**, including requests still in CPU/media preparation and
completed results whose response has not yet been released (**[doc]** `docs/serving.md:944-947`).

| Condition | HTTP | code | source |
| --- | --- | --- | --- |
| `outstanding_ >= C + max_pending_requests` | **429** | `server_overloaded` | `src/serve/generation_service.cpp:65-67` |
| absolute `pending-timeout-ms` deadline elapsed (covers preparation + media acquisition + FIFO wait) | **503** | `request_queue_timeout` | `generation_service.cpp:71-73,118-120` |
| media fetch timeout | **504** | — | `generation_service.cpp:112` |
| engine-wide failure / shutdown | **503** | `service_unavailable` | `generation_service.cpp:83` |

**Anthropic endpoint remaps these** — a detail the prior review did not have.
**[src]** `src/serve/anthropic_messages_response.cpp:137-144`: `server_overloaded` / 429 → **529**;
`request_queue_timeout` / `media_fetch_timeout` → **504**.

Defaults: `max_pending_requests = 16`, `pending_timeout_ms = 30000`
(**[src]** `include/ninfer/types.h:157-158`). Both are validated nonzero at
`engine_core.h:76-79`.

`GET /health` returns 503 only on engine-wide failure; **[doc]** `docs/serving.md:66`: "Temporary
queue saturation does not make the Engine unavailable."

---

## 2. Prefix reuse

### 2.1 It is a checkpoint cache, not a radix/block cache

This is the central architectural difference from vLLM. vLLM hashes fixed-size KV blocks and
matches the longest chain in a radix tree. NInfer instead publishes a **bounded catalog of
immutable whole-continuation checkpoints at specific token frontiers** and requires an exact match
against one of them.

The reuse condition, **[doc]** `docs/maintainer/resource-scheduling-and-context-cache.md:243-253`
(translated; original is Chinese):

> Current model targets contain both pageable Full Attention KV and recurrent state that cannot be
> losslessly rolled back from an arbitrary later state. Therefore a frontier is reusable **if and
> only if** the Program can prove:
> 1. a complete `StateImage` exists at that frontier;
> 2. Main KV satisfies the target-defined typed coverage;
> 3. the selected backend's KV and fixed state satisfy the same continuation;
> 4. token, position, Vision and mode identity match the incoming prompt exactly.
>
> When only tokens match, or only KV bytes or pages match, **what is missing is a complete
> continuation, not a partial cache hit.**

That last sentence is the design statement: NInfer refuses the partial-hit concept that a
block cache is built on. Hits are all-or-nothing at a published frontier.

### 2.2 The six named paths

**[src]** `src/serve/request_log.cpp:153-167` maps the enum to the JSONL strings:

| JSONL `prefix_reuse_path` | `CheckpointKind` | Semantics (**[doc]** `resource-scheduling-and-context-cache.md:271-283`) |
| --- | --- | --- |
| `root` | — | no reuse; full prefill from token 0 |
| `private_endpoint` | `SessionEndpoint` | latest continuable state of a completed request in this session |
| `private_turn_closure` | `TurnClosure` | stable state *before* the replaceable assistant suffix of the current turn |
| `private_response_replay` | `ResponseReplay` | stable state *before* the generation opener, so the response can be regenerated |
| `private_long_anchor` | `LongAnchor` | an earlier long-context recovery point chosen by the retention policy |
| `shared_stable_prefix` | `SharedStablePrefix` | immutable prefix shared by several histories; Fork-able by multiple private branches |

`CheckpointKind` itself: **[src]** `src/runtime/contract/types.h:341-347`.
`CheckpointScope { Private, Shared }` at `:349-352`.

The `TurnClosure` / `ResponseReplay` frontier rule (**[doc]** ibid. :283-286): both must sit before
any assistant suffix the next request might replace, "so that when the conversation system appends a
new user message or rewrites the generated tail, it can still reuse the stable history without
mistaking the mutable suffix for part of the prefix identity."

This is the **turn-structured, narrower** design the task asked about — but "narrower" is the wrong
word for the *reach*: `private_long_anchor` and `shared_stable_prefix` explicitly exist to give
long-context and cross-session reuse. It is narrower in **granularity** (frontier-quantised, not
block-quantised) and stricter in **admissibility** (exact continuation or nothing).

Selection is implemented in `src/targets/qwen3_6/impl/runtime/request_plan_impl.h:447-540`
(`ProgramImplCore::inspect_lane`), which sets `plan->reuse` and `plan->reuse_base` after calling
`qwen3_6::detail::prefix_matches(prompt, ledger, prefix_identity, selected.frontier)` and returning
`std::nullopt` on mismatch.

### 2.3 What counts as identity

**[doc]** `resource-scheduling-and-context-cache.md:305-311` — exact verification may use token IDs
and token types, position/MRoPE axes and RoPE delta, Vision spans and media digest, template/runtime
mode, and checkpoint frontier. "Session key, marker, hash and prefix index only narrow the candidate
set; they do not prove a hit."

**[doc]** `docs/serving.md:993`: "Reasoning-effort changes participate in rendered-token identity and
exact-prefix selection." So switching `reasoning_effort` mid-session invalidates reuse.

**[doc]** `docs/serving.md:996-999`: an *appended* mid-conversation system message is an ordinary
suffix and keeps `private_endpoint` eligibility; modifying/removing/moving a historical system
message correctly misses.

**[doc]** `docs/serving.md:181-185`: if a client reorders JSON members in a tool call, inserts
defaults, or rewrites a tool object, "the changed rendered input does not match the model-held
endpoint and can reuse only an earlier exact checkpoint." **[inference]** This is a real risk for pi:
any client-side normalisation of assistant tool-call JSON downgrades a `private_endpoint` hit to a
`turn_closure`/`long_anchor` hit or to root. HEAD's own commit
`a140e7ae "fix(engine): preserve exact agent prefix reuse"` and `719d56ef "fix(frontend): preserve
structured tool call intent"` (both 2026-09-03) are fixes in exactly this area — see §9.

### 2.4 **What state is cached: KV *and* recurrent state**

This is the answer R2 needs, and it is unambiguous.

**[src]** `src/targets/qwen3_6/export/ninfer/targets/qwen3_6/state_image.h:26-30`:

```cpp
struct StateImageSpec {
    LinearAttentionStatePoolSpec linear;
    std::int32_t hidden = 0;
    std::optional<DFlashLocalStateSpec> dflash_local;
};
```

and its device layout, `:45-51`:

```cpp
struct StateImageDeviceLayout {
    LinearAttentionStatePoolLayout linear;
    TensorRegion continuation_hidden;
    std::optional<CyclicKVCacheLayout> dflash_local;
    StateImageHostLayout host;
};
```

`LinearAttentionStatePoolLayout` is `{spec, std::vector<LayoutRegion> conv, std::vector<LayoutRegion>
recurrent}` (**[src]** `src/core/linear_attention_state.h:25-29`), i.e. the **gated-delta-net
convolution history and the FP32 recurrent state, per layer**.

So a checkpoint = KV pages + the complete recurrent/mamba-class state + the continuation hidden
vector. Restated by **[doc]** `README.md`: "A reusable prefix checkpoint contains KV and the complete
continuation state for its exact prompt frontier", and **[doc]** `docs/serving.md:977`: "Reuse
validation covers KV, recurrent state, hidden state, selected-backend state, and the exact prompt
frontier."

Checkpoint validity, **[doc]** `resource-scheduling-and-context-cache.md:291-299`: a checkpoint is
valid iff its StateImage has at least one complete Device *or* Host replica, **and** every required
KV logical page has at least one replica with a matching content epoch and sufficient coverage. It is
"Device-ready" only when all execution requirements are already on device.

### 2.5 Eviction policy — **not LRU**

**[doc]** `resource-scheduling-and-context-cache.md:890-905` (§10.1 Retention policy):

> The private retention class influences portfolio value through an owner prior; it **does not
> provide a fixed eviction order**. A shared owner's value comes from real demand and unexpired
> explicit credit. The planner may combine: deleting redundant replicas; demoting a Device replica to
> Host-only; deleting a checkpoint or suffix coverage that is no longer retained; evicting a complete
> inactive owner.
>
> If a placement change would delete a checkpoint's last complete State or required KV coverage, the
> same target must first establish a replacement, or delete that checkpoint at the same time.
>
> **Placement only changes at the resource boundaries of admission, capture, finish, or explicit
> inactive release. Ordinary decode does not run periodic promotion/demotion.**

So: a bounded heuristic **value-based planner** (predicted immediate cost vs. predicted future loss),
run only at admission/capture/finish, with a three-tier placement ladder
Device → pinned Host → evicted. **[doc]** `docs/serving.md:869-874` documents the per-request
`materialization` JSONL object exposing that decision, with stop reasons `no_pressure`,
`queue_exhausted`, `target_budget`, `expansion_capacity`, `time_budget`, `value_of_next_expansion`,
and an explicit disclaimer: "Search is bounded and heuristic; these diagnostics do not claim model or
global optimality."

Catalog size is bounded, not memory-bounded: `--max-private-continuations` (default `2C`),
`--max-shared-prefixes` (default `max(C,4)`), `--max-long-anchors-per-continuation` (default 2).
**[doc]** ibid. §10.3: when there is no publication slot, an optional capture is skipped and a
terminal finish uses `Discard`.

`--no-prefix-reuse` selects "root-only Engine mode and cannot be combined with any of the seven
explicit context-cache capacity flags, including zero-valued flags" (**[doc]** `docs/serving.md:820`).

---

## 3. KV and memory

### 3.1 Storage modes — five, not three

**[src]** `include/ninfer/types.h:29-35`:

```cpp
enum class KvCacheStorage : std::uint8_t {
    BFloat16,
    Int8Group64,
    Fp8E4M3Row256,
    Nvfp4Group16,
    Fp8KeyNvfp4Value,
};
```

CLI spelling `--kv-dtype bf16|int8|fp8|nvfp4|k8v4`, default `bf16`
(**[doc]** `docs/cli.md` and `docs/serving.md:775`). `nvfp4` and `k8v4` were added by commit
`4ac73c4 "feat(kv-cache): add nvfp4 and k8v4 modes"` (2026-09-01) — **drift vs. the prior review**,
which listed only `bf16|int8|fp8`. Commit `21a0e85 "feat(kv-cache): use fp16 V storage and PV
compute"` (2026-09-02) also landed in this window.

Page size is fixed: **[src]** `src/core/paged_kv_cache.h:18`
`inline constexpr std::int32_t kPagedKVPageSize = 64;`. **[doc]** `docs/cli.md`: `--kv-capacity` "is
rounded up to the 64-token page size."

### 3.2 Pool sizing and its trade

One shared Main Text KV pool serves **both** active requests and retained prefixes
(**[doc]** `README.md`: "one shared startup-fixed KV pool across active requests and retained
prefixes"). That is the core trade: every token you retain for reuse is a token unavailable for
concurrency, and the pool cannot grow at runtime.

`--kv-capacity auto` (**[src]** `src/runtime/engine/kv_capacity.cpp:74-135`) measures memory after
weights, subtracts `automatic_headroom_bytes` (default **1 GiB**,
`include/ninfer/types.h:46`), then picks the largest legal page-group count on the target's
`SequenceCapacityCurve`. It does **not** probe allocations and does not resize later
(**[doc]** `docs/cli.md`, "Context and memory").

**The hard constraint the prior review missed** — **[src]**
`src/targets/qwen3_6/impl/runtime/layouts_impl.h:582-598`:

```cpp
const std::uint32_t logical_pages  = page_count(options.max_context);
const std::uint32_t minimum_pages  = std::max(logical_pages, options.max_concurrency);
const std::uint64_t maximum_pages64 =
    static_cast<std::uint64_t>(options.max_concurrency) * logical_pages;
...
if (options.kv_capacity.explicit_tokens < options.max_context) {
    throw std::invalid_argument("kv_capacity must be at least max_context");
}
const std::uint32_t requested_pages = page_count(options.kv_capacity.explicit_tokens);
if (requested_pages < minimum_pages || requested_pages > maximum_pages64) {
    throw std::invalid_argument(
        "kv_capacity is outside the usable range for max_context and max_concurrency");
}
```

So `max_context <= kv_capacity <= max_concurrency * max_context`. Misconfiguration **throws at
startup** rather than silently truncating. That materially softens the prior review's "easy to
misconfigure into something that silently truncates" for `--kv-capacity`.

### 3.3 Defaults, and which are traps

**[src]** `include/ninfer/types.h:145-160` (`EngineOptions`), cross-checked against the CLI/serve
tables:

| Option | Engine default | CLI default | serve default | Trap? |
| --- | ---: | ---: | ---: | --- |
| `max_context` | 2048 | **2048** | **8192** | **Yes — real trap.** Confirmed. |
| `kv_capacity` | `explicit(2048)` | follows `--max-context` | follows `--max-context` | Coupled; illegal values throw. |
| `max_concurrency` | **1** | n/a | **1** | **Yes.** Default is serial. |
| `max_pending_requests` | 16 | n/a | 16 | no |
| `pending_timeout_ms` | 30000 | n/a | 30000 | **Yes for our workload** — see below. |
| `prefill_chunk` | 1024 | 1024 | 1024 | multiple of 128 enforced |
| `kv_cache` | `BFloat16` | `bf16` | `bf16` | **Yes** — bf16 KV on a 32 GiB card with a 20 GiB NVFP4 weight arena leaves very little pool. |
| `host_state_slots` | 8 | n/a | 8 | no |
| `host_kv_capacity_bytes` | 8 GiB | n/a | `--host-kv-mib 8192` | pinned host RAM, not GPU |
| `use_cuda_graph` | true | on | on | no |
| `enable_vision` | **false** | off | off | media rejected with 400 `vision_disabled` |
| `speculative` | **None** | off | off | **Yes** — MTP is opt-in |
| `default_max_tokens` | — | `--max-new 128` | **8192** | CLI 128 is low |

**The `--max-context 2048/8192` trap is confirmed and is worse than it looks**, because
`--kv-capacity` defaults to follow it *and* the legal ceiling is `C × max_context`. Starting
`ninfer-serve` with no flags gives you 8,192 tokens of context and 8,192 tokens of pool. Our
workload's ~64k input turns would fail admission with `ContextLengthExceeded`.

**`--pending-timeout-ms 30000` is a second trap for us.** The deadline is absolute and starts
*before* preparation (**[doc]** `docs/serving.md:947-950`, **[src]** `engine_core.h:169-178`). Our
baseline observed up to 480 s of queue wait. Under NInfer defaults those requests would 503 at 30 s.

**[doc]** `docs/serving.md:816-819`: `--host-kv-mib` is a **shared pinned-host** capacity for Main
*and* the selected backend pool, consumed in physical page extents, independent of
`--host-state-slots`. It backs checkpoint overflow, not active-request KV — it is a cache tier, not
context extension.

---

## 4. Speculative decoding

### 4.1 Backends and flags

**[src]** `include/ninfer/types.h:68-78`:

```cpp
enum class SpeculativeBackend : std::uint8_t { None, Mtp, DFlash };
struct SpeculativeOptions {
    SpeculativeBackend backend = SpeculativeBackend::None;
    std::uint32_t draft_tokens = 0;
    ProposalHead proposal_head = ProposalHead::Full;
};
enum class ProposalHead : std::uint8_t { Full, Optimized };
```

`--spec mtp|dflash`; MTP `--draft-tokens 1..5`, DFlash `1..15`; `--lm-head-draft` selects
`ProposalHead::Optimized`. **DFlash is new relative to the prior review** and is
**35B-A3B text-only** and mutually exclusive with `--vision` and with MTP
(**[doc]** `docs/cli.md`, "Speculative decoding"). **It is therefore not available for
Qwen3.8-27B.** Residency is frozen at startup: no `--spec` omits the MTP/DFlash weights entirely.

### 4.2 Verification

Draft/verify is a `T = k + 1` column round. **[src]**
`src/ops/kernel/speculative_round.cuh:19-36` builds the verify inputs: column 0 is the anchor,
columns `1..extent` are the drafts, columns beyond the extent repeat the anchor (padding).

The accept rule, **[src]** `src/ops/kernel/speculative_round.cuh:59-72` (comment on
`speculative_accept_greedy_drafts_kernel`):

> Commits the round's accepted tokens plus one correction/bonus token, then advances the target
> length. The greedy branch (config temperature <= 0) is bit-identical to the original argmax
> accept: keep the longest draft prefix whose target argmax matches, then take the target argmax at
> the divergence column. The sampling branch (temperature > 0) runs **distribution-correct
> speculative rejection sampling** over the verify logits with a one-hot (greedy) draft: accept
> `drafts[i]` with probability `p_i(drafts[i])` under the truncated target distribution, resample
> from the masked residual on the first rejection, and draw a bonus from the last column when every
> draft accepts. The draft-proposal path stays greedy, so `q` is one-hot and the accept test
> collapses to `u < p_i(drafts[i])`.

So the sampling path is the standard Leviathan/Chen rejection-sampling scheme, and the greedy path is
exact argmax. Verification is output-distribution-preserving.

### 4.3 **Rollback on rejection: there is none, by construction**

The recurrent state is **never speculatively advanced**, so there is nothing to roll back. This is
the mechanism, in code terms.

**Step 1 — verify records instead of updating.** **[src]**
`src/targets/qwen3_6/impl/runtime/text_context.h:113-116`:

```cpp
enum class GdnStateAction : std::uint8_t {
    UpdateInPlace,
    RecordForReplay,
};
```

Speculative rounds select `RecordForReplay`. **[src]**
`src/targets/qwen3_6/impl/runtime/speculative_target_impl.h:12-15`:

```cpp
if (frame.replay_records == nullptr) {
    throw ...;
}
card.set_gdn_state_action(GdnStateAction::RecordForReplay, frame.replay_records);
```

What is recorded, **[src]** `src/core/gdn_replay_records.h:36-41` — per layer, per column, the four
**raw transition inputs**, not states:

```cpp
struct GdnReplayRecordLayer {
    Tensor conv;  // BF16 [conv_channels, width, rows]
    Tensor key;   // BF16 [key_dim, qk_heads, width, rows]
    Tensor value; // BF16 [value_dim, value_heads, width, rows]
    Tensor gate;  // FP32 [2, value_heads, width, rows], ordered {g, beta}
};
```

Capacity is `record_capacity = max_concurrency` rows (`layouts_impl.h:155`), i.e. one row per lane,
`width` columns deep.

**Step 2 — the accepted prefix is folded in afterwards.** **[src]**
`include/ninfer/ops/gdn_replay.h:13-45`:

```cpp
struct GdnReplayFoldRow {
    std::int32_t source_state_slot;
    std::int32_t destination_state_slot;
    std::int32_t commit_columns;
};
```

> Replays each row's `[0, commit_columns)` record prefix across every registered GDN layer and
> updates the caller-selected absolute linear-attention destination state slot. ... `commit_columns`
> is in `[0,T]`. **Zero is a strict no-op for the row: no record or state is read and neither
> recurrent state nor convolution history is written.** For a positive extent, the Op consumes raw
> key/value/{g,beta} records in order, writes the final FP32 recurrent state, and sets convolution
> history to `tail_3(old_history || conv_record[0:commit_columns])`.

**Step 3 — the commit site.** **[src]**
`src/targets/qwen3_6/impl/runtime/program_impl.h:10024-10073`. Before folding, every speculative row
is asserted to still be **at its recorded base** (`:10036-10047`):

```cpp
if (sequence.execution_frontier != pending.base_E ||
    sequence.ledger_frontier != pending.base_S ||
    ...
    sequence.text_kv_valid != pending.base_E ||
    (speculative_backend == SpeculativeBackend::Mtp &&
     sequence.mtp_kv_valid != pending.base_E) ||
    (speculative_backend == SpeculativeBackend::DFlash &&
     sequence.dflash_context_frontier != pending.base_E)) {
    throw std::logic_error("speculative pending row is not at its recorded base");
}
const std::uint32_t committed = cancelled[row] ? 0U : accepted_tokens[row];
...
fold_rows[row] = ops::GdnReplayFoldRow{.source_state_slot      = selectors.source,
                                       .destination_state_slot = selectors.destination,
                                       .commit_columns         = static_cast<std::int32_t>(committed)};
```

Then `replay_fold->execute(...)` (`:10072`). A cancelled row gets `commit_columns = 0` — a strict
no-op. The KV validity frontiers (`text_kv_valid`, `mtp_kv_valid`, `dflash_context_frontier`) are
likewise the *base* until the commit advances them; speculatively written KV bytes past the accepted
frontier are simply not covered by a valid frontier and are overwritten next round.

**Step 4 — the design rationale and its one caveat.** The maintainer doc
`docs/maintainer/replayssm-gdn.md` ("ReplaySSM: raw-input replay of GDN speculative state") gives the
full argument. §3.2 (`:229-249`): verify runs the ordinary recurrence from `S0` producing a transient
trajectory `S_verify`, and "after verify finishes, it is **not** published as committed state; the
persistent checkpoint `S0` is unchanged." §3.3 (`:250-272`): fold restarts from the same `S0` and
applies exactly `m` transitions; "when `m = 0` the state is strictly unchanged. The rejected suffix
`R_{m+1:T}` is never read by the fold."

The caveat, and it is stated by the authors as the *core requirement* of the technique
(`replayssm-gdn.md:9-14`):

> Replay fold **must execute the same finite-precision state transition as the verify recurrence**,
> not merely compute an algebraically equivalent formula in the reals.

§3.4 (`:273-310`) then proves by induction that if both paths call the identical deterministic
floating-point transition on identical record bits, `S_m^{fold} = S_m^{verify}` **bitwise**, not just
in the reals. §4 is an extended treatment of how algebraically-equivalent-but-numerically-different
rewrites would cause state drift that persists across rounds.

**[inference]** This is the structural difference from vLLM's hazard: vLLM must *undo* a mutation it
already made to a recurrent state; NInfer never makes the mutation until the accept length is known.
Note the commit-length nuance from `replayssm-gdn.md:213-228`: with `D` drafts and `A` accepted, `p =
A + 1` tokens are licensed but the state commit length is `0 <= m <= p`, because a stop condition can
truncate the output below the licensed span — and the code handles that case explicitly
(`program_impl.h:10063-10067`, `partial_terminal` and `hidden_selectors`). **[doc]**
`docs/serving.md:1003-1006` states the client-visible consequence: "If a stop truncates a multi-token
MTP or DFlash round, the Engine commits the exact accepted target prefix so a following compatible
turn can reuse it."

I have **not** built or run NInfer, so I am reporting the design and its implementation, not
verifying it empirically. R2 owns the correctness verdict.

---

## 5. API surface

### 5.1 Endpoints (**[doc]** `docs/serving.md:49-61`)

`GET /health` · `GET /v1/models` · `GET /v1/models/{id}` · `POST /v1/chat/completions` ·
`POST /v1/responses` · `POST /v1/responses/input_tokens` · `GET|DELETE /v1/responses/{id}` ·
`GET /v1/responses/{id}/input_items` · `POST /v1/messages` · `POST /v1/messages/count_tokens`.

Auth: `--api-key` accepted as OpenAI bearer **or** Anthropic `x-api-key`; `/health` and CORS
preflight stay unauthenticated. `--cors` off by default.

**New at HEAD:** llama.cpp-compatible `timings` on every Chat Completions response, plus opt-in
`timings_per_token` and streaming `return_progress` (commit `550d0ac3`, 2026-09-03;
**[doc]** `docs/serving.md:110-112,230-290`, **[src]**
`src/serve/openai_chat_request.cpp:862-865`). Not present in the prior review.

### 5.2 `reasoning_effort` — verified against source, and the prior review is **partly wrong**

**Top-level `reasoning_effort` is the supported spelling.** **[src]**
`src/serve/openai_chat_request.cpp:836-849` parses it and accepts the string set
`none, minimal, low, medium, high, xhigh, max`. Of those, only `none|low|medium|xhigh` are
*executable* against the registered Qwen templates; `minimal|high|max` parse and then fail with HTTP
400 `reasoning_effort_not_supported` (**[doc]** `docs/serving.md:186-189,212-214`). Capability comes
from the artifact's embedded `frontend/chat_template.jinja`, not from the `model` field.

**`chat_template_kwargs` accepts exactly two keys, and `reasoning_effort` is not one of them.**
**[src]** `src/serve/openai_chat_request.cpp:810-833`:

```cpp
for (auto iterator = kwargs.begin(); iterator != kwargs.end(); ++iterator) {
    if (iterator.key() != "enable_thinking" && iterator.key() != "preserve_thinking" &&
        !iterator.value().is_null()) {
        bad_request("chat_template_kwargs." + iterator.key() + " is not supported",
                    "chat_template_kwargs", "chat_template_option_not_supported");
    }
}
```

**Drift vs. the prior review, in two directions:**

1. The prior review said "Only `preserve_thinking` is accepted." **That is now wrong** —
   `enable_thinking` is accepted inside `chat_template_kwargs` too, and is merged with the top-level
   alias. (Commit `eda40242 "feat(serve): align protocol adapters with engine capabilities"`,
   2026-08-28 — so this was already true on 2026-09-01 and the prior review's claim was
   **incorrect at the time**, not merely stale.)
2. The prior review said "sending both at once returns `conflicting_template_option`."
   **That is an overstatement.** `conflicting_template_option` fires in three distinct places and
   none of them is "both fields present":
   - `openai_chat_request.cpp:824-830` — the *same* key given at top level and in
     `chat_template_kwargs` with **different** boolean values;
   - `openai_chat_request.cpp:430-433` — assistant `reasoning` and `reasoning_content` history
     aliases with different values;
   - `src/serve/translate.cpp:135-140` — the real one:
     ```cpp
     const bool enables_thinking = requested != RequestedReasoningEffort::None;
     if (request.enable_thinking && *request.enable_thinking != enables_thinking) {
         invalid_prompt_option("reasoning effort conflicts with enable_thinking", ...);
     }
     ```
     i.e. only a **contradiction** (`enable_thinking:true` + `reasoning_effort:"none"`, or
     `enable_thinking:false` + a real effort). `enable_thinking:true` + `reasoning_effort:"medium"`
     is legal and consistent.

**Net effect on pi.** `modules/pi-coding-agent/settings.nix:137-157` sets
`thinkingFormat = "chat-template"` and puts both `enable_thinking` and `reasoning_effort` inside
`chat_template_kwargs`. Against NInfer at this HEAD, `enable_thinking` there would now be accepted,
but `reasoning_effort` there would still be rejected with HTTP 400
`chat_template_option_not_supported`. **So the prior review's operational conclusion stands — a
`settings.nix` change is required — but its stated reason was wrong.** The required change is
narrower than described: move `reasoning_effort` to top level; `enable_thinking` may stay where it is
(or move too), and the two may coexist as long as they agree.

`/v1/responses` is **stricter**: **[src]** `src/serve/openai_responses_request.cpp:987-992` accepts
only `preserve_thinking` in `chat_template_kwargs`; `enable_thinking` there is rejected. Responses
uses `reasoning.effort` instead (**[doc]** `docs/serving.md:411`).

### 5.3 Tool calling

Present and reasonably complete for a non-constrained engine:

- **Parser:** Qwen XML-ish markup, `src/targets/qwen3_6/impl/frontend/tool_call_parser.{h,cpp}`.
  The header comment (`:14-17`) states the contract: "Qwen's tool syntax carries each argument as
  untyped text. This terminal contract records only the supported top-level JSON Schema types needed
  to normalize that text. A type mismatch remains a structured call for consumer validation;
  recursive validation is outside this non-strict contract."
- **Typing:** a top-level parameter `type`, or an `anyOf`/`oneOf` composed entirely of explicit
  primitive types, guides conversion of untyped text; schema mismatch still yields a structured call
  so the tool consumer can report the error and continue the agent loop
  (**[doc]** `docs/serving.md:157-165`).
- **Known limitation:** the Qwen wire format has no delimiter escape, so an unmatched nested
  `<parameter=...>` opener or a standalone `</parameter>` makes the whole tool-call region fall back
  to ordinary content (**[doc]** `docs/serving.md:167-170`).
- **`tool_choice`:** `auto`, `none`, and `allowed_tools` in `auto` mode only. **Required or named
  choice is rejected**, as is `strict:true` and `parallel_tool_calls:false` with tools enabled
  (**[doc]** `docs/serving.md:120-122`). Parallel calls are enabled.
- **Diagnostics:** `request_done.result.tool_call_parse` records marker completeness, structured
  call count, omitted empty non-string args, schema-mismatched args, and a fallback reason from
  `{none, malformed_structure, duplicate_parameter, invalid_tool_name, undeclared_tool,
  trailing_content}` (**[doc]** `docs/serving.md:861-866`, **[src]** `src/serve/request_log.cpp:85-95`).
  **[inference]** This is directly useful to us: it is a per-request, text-free classification of
  malformed tool calls, which is exactly the failure mode we have been chasing on vLLM and cannot
  currently attribute.

### 5.4 Structured outputs / logprobs — **absent, and explicitly so**

**[src]** `src/serve/openai_chat_request.cpp:204-222`:

```cpp
static constexpr const char* fields[] = {
    "grammar", "structured_outputs", "guided_json",
    "guided_regex", "guided_choice", "guided_grammar",
};
...
bad_request(std::string(field) + " requests constrained decoding, which NInfer does not provide",
            field, "constrained_decoding_not_supported");
```

Also rejected when they request behaviour (**[doc]** `docs/serving.md:119-127`): JSON constrained
output, nonzero `logit_bias`, requested log probabilities, audio/file input or audio output,
`strict:true`, required/named tool choice, `parallel_tool_calls:false` with tools, explicit low/high
image detail, web search, moderation, low/high verbosity, stored Chat Completions, non-empty legacy
`functions`.

Accepted as semantically neutral: all-zero `logit_bias`, `logprobs:false`, `top_logprobs:0`,
`verbosity:"medium"`, empty legacy tool controls, text-only `audio`, `prediction`,
`repetition_penalty` **only at exactly 1.0** (**[src]** `openai_chat_request.cpp:227-238`),
`mm_processor_kwargs` only when empty/all-null (`:242-255`). Unknown **top-level** fields are
ignored; unknown **`chat_template_kwargs`** keys are rejected. That asymmetry is deliberate:
"Other non-null `chat_template_kwargs` are rejected rather than silently changing prompt semantics"
(**[doc]** `docs/serving.md:143`).

`n` must be 1. `response_format` limited to `{"type":"text"}`.

### 5.5 Prompt-cache hints and Anthropic specifics

OpenAI `prompt_cache_options` / `prompt_cache_breakpoint` map to shared-prefix **write candidates**,
max **four** per request (**[src]** `include/ninfer/types.h:22`
`kMaximumExplicitPromptCacheMarkers = 4`, added at HEAD). `prompt_cache_key` is explicitly **not** a
session key or prefix identity (**[doc]** `docs/serving.md:353-356`).

Anthropic `/v1/messages` supports system/user/assistant/thinking/tool-use history, assistant prefill,
`thinking: disabled|adaptive|enabled` (enabled requires `budget_tokens >= 1024` and `< max_tokens`),
block-level ephemeral `cache_control` (max four breakpoints, TTL `5m`/`1h` accepted as a hint only),
and reports verified reused tokens in `cache_read_input_tokens`. `display:"omitted"` is rejected.
There is a **Claude Code-specific** rule: a first system block beginning exactly with
`x-anthropic-billing-header:` is consumed before token counting and cache identity construction
(**[doc]** `docs/serving.md:663-670`). `POST /v1/messages/count_tokens` uses the real tokenizer,
template and media expansion.

---

## 6. Observability

`--request-log-jsonl FILE` (append mode, flushed per event, parent dir must exist, open failure
aborts startup, path rejected if it resolves to the artifact).

**Schema version is 20, not 18.** **[src]** `src/serve/request_log.h:23`:

```cpp
inline constexpr int kRequestLogSchemaVersion = 20;
```

emitted as `{"schema_version", kRequestLogSchemaVersion}` at `request_log.cpp:173`. **Drift vs. the
prior review's v18.**

Six event types (**[src]** `request_log.cpp:422,539,548,558,590,598`): `server_start`,
`request_start`, `request_rejected`, `request_done`, `request_error`, `throughput`. Every line
carries `timestamp_unix_ms`, a process-unique `server_instance_id`, and `event`.

`request_done` top-level keys, **[src]** `request_log.cpp:558-585`:
`request`, `result`, `timings_seconds`, `engine_timing`, `speculative`, `materialization`.

- `result`: `finish_reason`, `prompt_tokens`, `completion_tokens`, **`computed_prefill_tokens`**,
  **`prefix_cache_hit_tokens`**, **`prefix_reuse_path`**, `thinking_budget`,
  `model_thinking_tokens`, `thinking_control_tokens`, `thinking_control_applied`,
  `tool_call_count`, `tool_call_parse`.
- `timings_seconds`: `prepare`, `ttft`, `vision`, `prefill`, `decode`, `total`, full precision.
- `speculative`: `backend`, `draft_window`, `rounds`, `drafted_tokens`, `accepted_tokens`,
  `fallback_steps`, `accepted_per_position`.
- `engine_timing`: FIFO `queue_wait_seconds`, `device_wait_exposed_seconds`, and five mutually
  exclusive host phases under `host_exposed_seconds` (`engine_boundary`, `program_submit`,
  `program_post`, `engine_commit_output`, `engine_maintenance`), whose `total` is exactly their sum.
- `materialization`: the committed cache-placement decision — predicted immediate / future-loss /
  total ns, evaluated targets, planning ns, stop reason, budget-exhausted flag, degradation units,
  maximal-root-fallback flag.

**Doc/source discrepancy (minor):** `docs/serving.md:876-878` says `timings_seconds` "contains a
`speculative` object". **[src]** `request_log.cpp:578-583` puts `speculative` at the **top level** of
the record, a sibling of `timings_seconds`. Trust the source.

`throughput` (default every 5 s via `--log-stats-interval-ms`) carries interval deltas for tokens,
decode rounds and **`context_cache`** counters (selection, capture, transfer, COW, pressure spill,
private/shared owner degradation and eviction, checkpoint drop, pressure search, budget exhaustion,
maximal fallback, historical fork), plus end-of-interval scheduler gauges `running`, `prefilling`,
`decode_ready`, `waiting`, `materializing`, `capture_pending`, `terminal_pending`, and
`average_size` = decode row-rounds / decode rounds.

Two caveats the doc states explicitly and that matter for analysis
(**[doc]** `docs/serving.md:884-889, 917-925`): per-request `engine_timing` values **must not be
summed across concurrent requests** (in a compact batch every participant is delayed by the full
round); and `throughput.host_work` is "the aggregation authority" because the worker counts each
wall-time segment once, independent of batch size.

Privacy: no generated text, no prompts, no request bodies, no credentials; `argv` has the API key
replaced with `<redacted>`.

**[inference]** Verdict unchanged from the prior review, and if anything stronger: this is the
observability we want. `prefix_cache_hit_tokens` + `prefix_reuse_path` + per-request
`queue_wait_seconds` + `tool_call_parse` fallback reasons is a superset of what our vLLM `/metrics`
scrape gives us, and it is per-request rather than process-global.

---

## 7. Operational reality

### 7.1 Build

**[doc]** `README.md`, "Quick start": 64-bit Linux, **NVIDIA GeForce RTX 5090**, **CUDA Toolkit 13.1
or newer**, **CMake 3.28+**, a C++20 host compiler, Ninja, `pkg-config`, FFmpeg dev libs
(`libavformat >= 60`, `libavcodec >= 60`, `libavutil >= 58`, `libswscale >= 7`), `libcurl >= 7.85`.
**"The build rejects CUDA architectures other than `sm_120a`."**

```bash
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

**[doc]** ibid.: "Tests, benchmarks, and maintainer tools are excluded from the default build. **There
is no install target or packaged binary distribution**; run NInfer from its source build tree."

Vendored under `third_party/`: `cpp-httplib` (bumped to 0.54.1 on 2026-09-02), `nlohmann` JSON,
`spdlog` (added 2026-09-01, commit `4a1a218`), `utf8proc`. No package manager needed for those.

Nixpkgs: re-verified today. `nix-instantiate --eval -E '(import <nixpkgs> {}) ? ninfer'` → **`false`**.

### 7.2 **There is now a Dockerfile — but still no published image**

**Drift.** The repo root contains a `Dockerfile` and `.dockerignore`, and `README.md` has a
**"## Docker"** section. It is a two-stage build:
`nvidia/cuda:13.1.2-devel-ubuntu24.04` → build → `nvidia/cuda:13.1.2-runtime-ubuntu24.04`, copying
`ninfer` and `ninfer-serve` into `/usr/local/bin`, `EXPOSE 8080`, `STOPSIGNAL SIGTERM`.

The README instructs `docker build --tag ninfer:local .` — i.e. **you still build it yourself**. I
found no reference anywhere in the repo to a published image on GHCR, Docker Hub, or any registry,
and there are no releases or tags (§8). So the prior review's "There is no upstream OCI image for
NInfer" remains **operationally true**, but "no OCI packaging at all" is now false — the hard part
(a correct CUDA 13.1 build recipe) is done and upstream-maintained.

**[inference]** This materially lowers the packaging cost the prior review flagged as blocker #1.
Building this image on redtruck is a `docker build` against a known-good recipe, not a nix packaging
project. It does not solve the "we consume an upstream image" preference, but it removes the
"nix build OOMs on 32 GB" objection entirely.

### 7.3 Weights: **a separate artifact is required**

**Confirmed, and this is a hard cost for any A/B.** **[doc]** `README.md` model table:

| Model | Weights | Artifact file | Source |
| --- | --- | --- | --- |
| Qwen3.8-27B | `nvfp4` | `qwen3_8_27b_nvfp4.ninfer` | `neroued/Qwen3.8-27B-nvfp4-NInfer` |

Download: `hf download neroued/Qwen3.8-27B-nvfp4-NInfer qwen3_8_27b_nvfp4.ninfer --local-dir models`.

It is a **single `.ninfer` container file**, not a HF-format directory: "Every artifact also embeds
the tokenizer, chat template, and media frontend resources required by its registered target."
Provenance, **[doc]** `README.md` License section: "The Qwen3.8-27B NVFP4 artifact also uses the
fixed mixed FP8/NVFP4 weights from `unsloth/Qwen3.8-27B-NVFP4`."

So it is *derived from* the files already on disk but is **not** loadable from them. There is a
converter in-tree (`tools/convert/qwen3_8_27b/`) — **[cannot determine]** whether it can produce a
byte-identical artifact from our existing local `unsloth/Qwen3.8-27B-NVFP4` files without also
fetching the maintainer's fixed weights; I did not read the converter. Either way, **plan for a
second full copy of the weights on disk during any A/B**, plus new `models.nix` entries with a new
repo, new file list, and new sha256.

Weight arena sizes, **[doc]** `docs/performance.md:186`: groupwise-int **16.672 GiB**,
NVFP4 **19.729 GiB**. On a 32 GiB card that leaves roughly 12 GiB for KV + state + workspace +
graphs before the 1 GiB auto headroom.

### 7.4 What it explicitly will not do

**[doc]** `README.md`, "Capabilities and limits": one RTX 5090 and one resident model per Engine;
startup-fixed 1..8 active requests with bounded FIFO ingress; **no request preemption, priority/QoS,
active-request swapping, weight offload, multi-GPU, or distributed serving**; one shared startup-fixed
KV pool across active requests and retained prefixes; no runtime model discovery or unregistered
checkpoint fallback; NInfer does not execute tools; the in-tree C++ headers are not an installed SDK.

---

## 8. Maturity signals — factual

All **[api]** figures retrieved 2026-09-03 from `api.github.com/repos/Neroued/ninfer`; commit figures
from the full local clone.

| Signal | Value |
| --- | --- |
| Repo created | **2026-06-26** (first commit 2026-06-25) |
| Last push | **2026-09-03T13:51:23Z** — same day as this study |
| Total commits on `master` | **974** |
| Commits/month | 2026-06: 252 · 2026-07: 507 · 2026-08: 194 · 2026-09 (3 days): 21 |
| Contributors | **3**: `Neroued` 966, `MichaelDementii` 7, `pinizhaninov` 1 |
| Stars | **1,272** |
| Forks | **244** |
| Watchers (subscribers) | **12** |
| Releases | **0** |
| Tags | **0** |
| Open issues + PRs | **36** (`open_issues_count`) |
| Default branch | `master` |
| Archived | no |
| License | Apache-2.0 |
| CI | **none** — no `.github/` directory at all |
| Tests | 107 `.cpp` test files under `tests/`, registered with CTest via a local `ninfer_add_test` helper (`tests/CMakeLists.txt`); covers admission policy, resource manager, KV capacity, state store, GDN replay records, request log, tool-call parser, OpenAI/Anthropic schema, serve options. Plus `tests/test_bench_matrix.py`, `tests/test_serve_corpus.py`. Excluded from the default build (`BUILD_TESTING=OFF` in the Dockerfile). |
| Stability statement | **none found.** No "production-ready", "stable", "experimental", or API-stability wording in `README.md`, `CONTRIBUTING.md`, or `AGENTS.md`. |
| Third-party benchmarks | none found in-repo |

Notable: issue **#172** ("Support resumable output-limit generations without re-decoding accepted
tokens") was opened by an external user (`GiorgioRegni`) on **2026-09-03**, following
`CONTRIBUTING.md`'s "open an Issue before implementation" rule. So there is real outside engagement,
not just stars.

**[inference]** Read: **10 weeks old, one dominant author, extremely high commit velocity, 1.3k
stars, zero releases, zero CI, no stability statement, but a large and specific test suite and
detailed maintainer design documents.** The prior review's "maturity is unknown" is now *known* and
the answer is "young and single-maintainer, but not abandoned or unserious." The specific risks are
(a) no tagged version to pin — you would pin a commit SHA; (b) no CI means every commit's build
health is unverified by machine; (c) bus factor 1; (d) the API/CLI contract can move under you, and
demonstrably does (five of the drift items in §9 landed in the last 72 hours).

---

## 9. Re-verification of `docs/local-llm-review-2026-09-01/03-ninfer.md`

Claim-by-claim against HEAD `a140e7ae`. **Verified** = I found it in source or in-repo docs.
**DRIFT** = changed since, or was wrong.

### "What it is" section

| Prior claim | Status |
| --- | --- |
| Apache-2.0; docs are `README.md`, `docs/{cli,serving,performance}.md` | **Verified.** |
| From-scratch C++20/CUDA for a closed set of registered Qwen checkpoints on a single RTX 5090 | **Verified** (`README.md`). |
| Two binaries `ninfer` / `ninfer-serve` | **Verified** (`apps/cli`, `apps/serve`; Dockerfile copies both). |
| Build rejects anything but `sm_120a` | **Verified** (`README.md`). |
| Qwen3.8-27B nvfp4 registered, weights derived from unsloth | **Verified** (`README.md` model table + License section). |
| Also registers Qwen3.6-27B (int + nvfp4) and Qwen3.6-35B-A3B | **Verified** — five artifact identities total. |
| Native `--reasoning-effort low\|medium\|xhigh` | **Verified** (`docs/cli.md`). |
| `--spec mtp --draft-tokens 1..5` plus `--lm-head-draft` | **Verified**, but **DRIFT (addition):** a second backend `--spec dflash --draft-tokens 1..15` now exists. It is **35B-A3B text-only**, so irrelevant to Qwen3.8-27B. |
| `--kv-dtype bf16\|int8\|fp8` | **DRIFT.** Now five modes: `bf16\|int8\|fp8\|nvfp4\|k8v4` (`include/ninfer/types.h:29-35`; commit `4ac73c4`, 2026-09-01). `nvfp4` KV is potentially significant for us and was not evaluated. |
| Context 262,144 (131,072 for Qwen3.8 MTP3) | **Verified as a benchmark setting**, `docs/performance.md:46`: "Maximum context 262,144 tokens; 131,072 for Qwen3.8 MTP3". `README.md` "Evaluation" adds that Qwen3.8-27B NVFP4 text eval used **252,928** tokens "to fit the RTX 5090 after weights". The 131,072 figure is the campaign's chosen ceiling, not a stated architectural limit — I could not find a hard MTP context cap in source. **Partly unverified.** |
| `--max-concurrency 1..8` + bounded pending queue | **Verified**, and now characterised: it is also a startup allocation, and the queue has head protection + proof-carrying backfill (§1.4). |

### "Published performance"

| Prior claim | Status |
| --- | --- |
| Qwen3.8-27B NVFP4 corpus makespan: peak at **C=4, 2.83×** vs C=1, **432.9 tok/s** aggregate decode | **Verified — still present verbatim**, `docs/performance.md:127-133` (`nvfp4` makespan table, C=4 row). |
| MTP acceptance ~57–61% for that model | **Verified for that table** (60.8 / 59.2 / 58.0 / 57.6% at C=1/2/4/8). **But incomplete — see below.** |
| Qwen3.8-27B groupwise-int: C=8 gives 2.09×, 315.3 tok/s, ~58–59% | **Verified**, `docs/performance.md:112-117`. |
| Qwen3.6-27B NVFP4: C=8 aggregate decode 1,147 tok/s, 68.6% acceptance | **Verified**, `docs/performance.md:158`. |
| "prefill 11,192 → 2,511 tok/s as context grows; server TTFT 693 ms → 103.8 s" | **Verified but MIS-ATTRIBUTED in context.** Those are **Qwen3.6-27B NVFP4** numbers (`README.md` single-request table: 11,191.5 → 2,510.6). The equivalent numbers for **our** model, Qwen3.8-27B NVFP4, are **8,340.4 tok/s @ 7,680 tokens → 5,297.9 @ 64,512 → 3,544.7 @ 130,048 → 2,203.1 @ 260,096**, with server TTFT **931.6 ms → 12,281 ms → 36,854 ms → 118,355 ms** (`docs/performance.md:606-613`). **R3 must use the 3.8 row, not the 3.6 row.** The 64,512-token point (5,297.9 tok/s, 12.3 s TTFT) is the one that matches our ~64k turns. |
| **NEW, not in the prior review** | `README.md:122-134` now publishes a **"Concurrent MTP3 decode"** saturation table that includes a **Qwen3.8-27B `nvfp4`** row: **C=1 143.8 tok/s / 48.9% · C=2 267.6 / 48.1% · C=4 461.1 / 45.8% · C=8 766.6 / 46.0% · C8/C1 = 5.33×.** This is a *different* benchmark from the makespan table (fixture `long_decode_aime26_15`, 293-token prompt, 8,192-token output, saturated full-batch intervals only). It shows **near-linear scaling to C=8** for our exact model — the opposite shape from the makespan table's C=4 peak — and **much lower acceptance (~46–49%)**. |
| **Doc inconsistency worth flagging** | That Qwen3.8 row appears in `README.md` but **not** in `docs/performance.md`'s own "Concurrent MTP3 decode saturation" table (`:141-190`), which still lists only the three Qwen3.6 profiles. I cannot reconcile the two documents from the repo alone. **[cannot determine]** which is current. |
| Per-scenario acceptance (not in the prior review, and it matters) | `docs/performance.md:615-629` for Qwen3.8-27B NVFP4 MTP3: Code **76.4%**, Translation **75.0%**, Structured **90.8%**, Story **37.4%**; long-reasoning fixtures 76.0% / 56.2% / 64.6%. **Acceptance varies 37–91% by workload.** Any single "NInfer gets X% acceptance" number is meaningless for our agent traffic without picking the right row. |
| "Our measured stack is doing 97.9 tok/s with 67.9% MTP acceptance — *better* acceptance than NInfer" | **Void.** MTP was removed from our stack in #156. Per the study plan this comparison no longer exists. Not re-verified; out of my scope. |
| Caveats: project's own benchmarks, no vLLM baseline, INT8 KV not fp8, corpus-makespan is a batch benchmark | **All verified.** `docs/performance.md:47` confirms INT8 group-64 KV throughout. Additionally, and importantly: **`docs/performance.md:52` and `:97` state "Prefix reuse **disabled**" for every published campaign.** So *none* of NInfer's published numbers include its prefix cache. Against our 82% prefix-hit workload, all published prefill figures are worst-case. The prior review did not note this. |

### "The genuinely attractive parts"

| Prior claim | Status |
| --- | --- |
| 1. `--max-concurrency 1..8` with real batching; sweet spot C=4 for this model | **Verified as continuous batching** (§1.2). **C=4 claim is now contested by NInfer's own docs** — the README saturation table puts the Qwen3.8 nvfp4 optimum at C=8 (5.33×). Both tables are in the repo. |
| 2. `--request-log-jsonl`, **schema v18** | **DRIFT: schema is v20** (`src/serve/request_log.h:23`). Field list is broadly as described and has grown (`materialization`, `tool_call_parse`, `engine_timing` host-phase split). Reuse-path names as described **plus three more**: `private_endpoint`, `private_response_replay`, `private_long_anchor`. |
| 3. Bounded queue: `--max-pending-requests` 16, `--pending-timeout-ms` 30 s, 429 `server_overloaded`, 503 `request_queue_timeout` | **Verified for OpenAI endpoints.** **Addition:** Anthropic `/v1/messages` remaps 429→**529** and timeouts→**504** (`anthropic_messages_response.cpp:137-144`). **Addition:** the capacity counted is `C + max_pending`, and it includes requests in CPU/media prep and completed-but-unreleased results, so effective queue depth is less than 16. |
| 4. Native `reasoning_effort`, values `none\|low\|medium\|xhigh` | **Verified** for what is *executable*; the parser also accepts `minimal\|high\|max` and then rejects them with `reasoning_effort_not_supported`. |
| 5. `--host-kv-mib` pinned-host KV overflow | **Verified.** Clarification: it backs **retained checkpoints**, not active-request context. It does not extend usable context. |
| 6. Anthropic `/v1/messages` + token counting, OpenAI `/v1/responses`, Chat Completions | **Verified.** **Addition:** llama.cpp-compatible `timings` / `timings_per_token` / `return_progress` landed 2026-09-03. |

### "The blockers"

| Prior claim | Status |
| --- | --- |
| 1. Build from source, no binaries, no nixpkgs package; needs CUDA 13.1+, CMake 3.28+, C++20, Ninja, FFmpeg dev, libcurl ≥7.85, pkg-config; **"There is no upstream OCI image for NInfer"** | Dependency list **verified verbatim**. `pkgs ? ninfer` **re-verified false** today. "No install target or packaged binary distribution" **verified**. **DRIFT: there is now an in-repo `Dockerfile` and a README Docker section** (§7.2). No *published* image, so the operational statement survives, but the packaging burden is much smaller than described. |
| 2. `chat_template_kwargs` rejected for unknown keys; **"Only `preserve_thinking` is accepted"**; "sending both at once returns `conflicting_template_option`" | **Rejection of unknown keys: verified** (`openai_chat_request.cpp:817-822`). **"Only `preserve_thinking`": DRIFT / wrong — `enable_thinking` is also accepted** on Chat Completions (though *not* on Responses). **"Sending both at once returns `conflicting_template_option`": overstated** — that error fires only on an actual contradiction (§5.2). **The operational conclusion — pi's `settings.nix` must move `reasoning_effort` to top level — still holds**, for a narrower reason. |
| 3. Weights are separate artifacts under the maintainer's HF account; plan for both on disk | **Verified.** Single `.ninfer` container from `neroued/Qwen3.8-27B-nvfp4-NInfer`; new repo, file list and sha256 required. |
| 4. No preemption, no priority QoS, no active-request swapping, no weight offload, no multi-GPU | **Verified verbatim** from `README.md` "Capabilities and limits", and structurally in `worker_loop`. |
| 5. No structured outputs / JSON-constrained decoding, no strict tool mode, no required/named `tool_choice`, no logprobs | **Verified** in source (`openai_chat_request.cpp:204-222` and `docs/serving.md:119-127`). |
| 6. **"Maturity is unknown."** No stars/contributors/release cadence in the docs; no stability statement; no third-party benchmarks; community forks for 3090 and Windows | **Superseded — see §8 for hard numbers.** 1,272 stars, 244 forks, 3 contributors, 974 commits since 2026-06-25, 0 releases, 0 tags, no CI, no stability statement, 107 test files. The forks claim I did not verify (I did not enumerate forks). |
| 7. `--max-context` default 2048 (CLI) / 8192 (serve); `--kv-capacity` defaults to `--max-context`; "easy to misconfigure into something that silently truncates" | **Defaults verified** (`include/ninfer/types.h:148-149`; `docs/cli.md` and `docs/serving.md` option tables). **"Silently truncates" is wrong for `--kv-capacity`:** an out-of-range value **throws at startup** (`layouts_impl.h:590-598`), and a prompt exceeding capacity is **rejected** with `ContextLengthExceeded` (`engine_core.h:1692`). The trap is real but it is loud, not silent. |

### The prior review's recommendation

"Do not migrate now. Do build a bench." Its two stated reasons were that `--max-num-seqs 2` was a
one-token fix and that observability was reachable via llama-swap's `/upstream`. Both premises are
outside my scope (S1 owns the first). **[inference]** I note only that the reason it gave for
deferring — that NInfer's advantages were cheaply obtainable on vLLM — does not extend to the two
things this reading actually establishes: the ReplaySSM commit-after-accept design (§4.3) and the
per-request `prefix_reuse_path` / `tool_call_parse` telemetry (§6). Neither has a vLLM equivalent.

### Drift summary (highest-value first)

1. **Published Qwen3.8-27B NVFP4 concurrency numbers now conflict inside the repo**: makespan says
   C=4 / 2.83× / 58% acceptance; README saturation says C=8 / 5.33× / ~46% acceptance. R3 must handle
   both.
2. **All published benchmarks ran with prefix reuse *disabled*** — never stated in the prior review,
   and it makes every published prefill number a worst case for our 82%-hit workload.
3. **The prior review quoted Qwen3.6-27B prefill numbers as if they characterised the 3.8 model.**
   The correct 3.8 NVFP4 figures are ~40% lower at short context (8,340 vs 11,192 tok/s).
4. **Acceptance is 37–91% depending on workload category** — a single number is not usable.
5. **`chat_template_kwargs` now accepts `enable_thinking`**; the `conflicting_template_option` claim
   was overstated. The required pi config change is narrower than described.
6. **Request-log schema v18 → v20**; three additional reuse paths.
7. **A Dockerfile now exists in-tree**; no published image.
8. **KV storage gained `nvfp4` and `k8v4` modes**; a `dflash` spec backend was added (not applicable
   to Qwen3.8).
9. **Maturity is no longer unknown** (§8): 1,272 stars, 3 contributors, 974 commits, 0 releases,
   **no CI**.
10. **New at HEAD, 2026-09-03**: llama.cpp `timings`; Anthropic thinking preserved across restarts;
    two tool-markup parsing fixes; `fix(engine): preserve exact agent prefix reuse` — i.e. the exact
    agent-prefix-reuse path we care about was being actively fixed **on the day of this reading**.
    That is both reassuring (it is being worked on) and a caution (it was broken until today).

---

## 10. Open questions I could not resolve

- **[cannot determine]** Whether `tools/convert/qwen3_8_27b/` can build a valid `.ninfer` artifact
  from our existing local `unsloth/Qwen3.8-27B-NVFP4` files without fetching the maintainer's
  re-packed weights. I did not read the converter.
- **[cannot determine]** Which of the two conflicting Qwen3.8 concurrency tables (README saturation
  vs. `docs/performance.md` makespan) reflects current behaviour, or whether they are simply
  different workloads with genuinely different optima. The methods sections describe different
  fixtures, which supports "different workloads", but only the README carries a Qwen3.8 saturation
  row and `docs/performance.md`'s saturation section does not, which looks like an incomplete doc
  update.
- **[cannot determine]** Whether NInfer's ReplaySSM design is *empirically* free of the vLLM hazard.
  I read the design and its implementation; I did not build or run it. R2 owns that verdict.
- **[cannot determine]** Whether a hard MTP-specific context ceiling exists (the 131,072 figure is
  stated as a benchmark setting, not a limit).
- **[unverified]** The prior review's claim that community forks exist for 3090 and Windows. I did
  not enumerate the 244 forks.
