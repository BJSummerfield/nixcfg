# Nested orchestrator: plan for the vLLM + pi plugin stack

**Date:** 2026-08-31
**Goal:** a top-level orchestrator that interviews, writes the ledger, and then does
*nothing but dispatch* — each unit of work handled by a **sub-orchestrator with fresh
context** that researches, delegates build/review, updates the ledger, and returns a few
hundred tokens.
**Inputs:** `2026-08-30-{ninfer-spike,qwen38-agentic-settings,agent-web-browser-toolkit,
spy-hunter-orchestration-review,local-llm-improvements-ranked}.md`.
**New here:** the plugin decision was re-run against the actual sources of three
candidate packages. It **reverses** `agent-web-browser-toolkit.md` §10 and §11.

---

## 0. The shape we are building

```
root dispatcher        depth 0   interview -> ledger -> loop { dispatch one unit }   never grows
  └── wp               depth 1   FRESH context per unit; research + judgement + ledger + commit
        ├── worker     depth 2   writes code
        ├── reviewer   depth 2   mechanical review, verdict returns to wp
        └── researcher depth 2   web + repo evidence
```

The root's only job is dispatch and the stop decision. Everything that accumulates tokens
dies with the sub-orchestrator. The load-bearing requirement is **depth 2 with fresh
context at depth 1** — that is what the plugin choice turns on.

---

## 1. The plugin decision: move to upstream `pi-subagents`

Three packages were checked against the four things this design needs. Only one has all
four, and it is not the one we run or the one the earlier doc recommended.

| | `@teelicht/pi-superagents` 1.14 (ours) | `@gotgenes/pi-subagents` 21.0.3 | **`pi-subagents` 0.61.0 (nicobailon)** |
|---|---|---|---|
| Nested delegation (depth 2) | works, but **only by evading a name-prefix policy** (§2) | **hard-blocked** — `subagent`, `get_subagent_result`, `steer_subagent` are *always* stripped from children, no override | **first-class**: `allowNestedSubagents: true`, or `tools: subagent, read` |
| Fresh context per child | `session-mode: lineage-only` (seeds a session with zero turns) | `inheritContext: false` default | `defaultContext: fresh \| fork`, named and documented |
| Per-agent thinking level | `thinking:` frontmatter (works, undocumented in its field table) | typed `thinkingLevel`, validated | `thinking:` + `subagents.defaultThinking` + `maxThinking` ceiling |
| Per-agent web access | `extensions:` frontmatter | **removed in v21** — children inherit the parent's extensions wholesale | `extensions:` *and* `subagentOnlyExtensions:` (loads a provider only in that agent's children) |
| Superpowers coupling | structural (§2) | none | none — zero mentions in README, src or docs |

Sources: `@gotgenes` `docs/configuration.md:159-160` ("This is the recursion guard —
without it, an agent could spawn agents of its own without bound"); `pi-subagents`
`docs/agents.md:304, 386, 403-404`.

**`@gotgenes` is out.** The earlier doc ranked it as the eventual swap on the strength of
its typed `thinkingLevel` and lifecycle events — both real — but it forbids the exact
thing we are building. A sub-orchestrator cannot exist there.

**Upstream `pi-subagents` is the right base**, and there is a second reason beyond the
table: it is by the same author as `pi-web-access`, and its bundled `researcher` agent is
written around `web_search` / `fetch_content` / `get_search_content`
(`agents/researcher.md:4`, `docs/agents.md:186-189`). The web problem that has been
blocking us — *"no subagent has pi-web-access at all"* — is the shipped default there
rather than something we wire up.

It also has features this design was going to hand-roll:

- `defaultReads:` — files a child reads before running. The ledger read order becomes
  declarative instead of an instruction the model may skip.
- per-agent `memory:` scopes, `maxSubagentDepth` per agent, `inheritProjectContext` /
  `inheritSkills` / `inheritGlobalContext`, `fallbackModels`, `timeoutMs`.
- `subagents.agentOverrides.<name>.{model,thinking,tools}` in pi settings — a clean
  nix-declarative surface that replaces our `modelTiers` block, at the **same config
  path** we already manage (`~/.pi/agent/extensions/subagent/config.json`), so
  `home.nix`'s copy-not-symlink activation carries over unchanged.

Honest cost: it is a much larger package (5.4 MB vs 1.2 MB) with surface we will not use —
missions, watchdog, chains, async runs, Codex/Claude-Code adapters. More to go wrong, more
to read. And 0.61.0 is a pre-1.0 version number on a package that clearly churns.

---

## 2. Why you were right about pi-superagents

Yes — it is superpowers-shaped, and the coupling is worse than "pass a flag". Two things,
both verified in `@teelicht/pi-superagents@1.14.0`:

**`WorkflowMode` has exactly one legal value: `"superpowers"`** (`shared/types.ts:49`,
`shared/schemas.ts:46-47`). Every `if (workflow !== "superpowers")` branch in
`superpowers-policy.ts` is unreachable dead code. There is no non-superpowers mode to
select — so there is no special arg to pass, which is the *bad* version of the answer: the
superpowers path is the only path, and it is on by default.

**The policy layer keys off the agent's name prefix.** `inferExecutionRole`
(`superpowers-policy.ts:69-71`) returns the agent name as a bounded role if it starts with
`sp-`, and `"root-planning"` otherwise. `resolveRoleTools` (`:216-232`) then strips
`DELEGATION_TOOLS` = `{subagent, subagent_status}` from every bounded role. So:

> **Naming a sub-orchestrator `sp-wp` silently removes its `subagent` tool.**

That inverts the advice in my previous draft (which suggested `sp-*` names so they read as
in-family) and it is a trap the earlier docs walked toward. Making it work means naming
agents *outside* the `sp-` convention purely to dodge a string check, plus using
`session-mode: lineage-only` because `standalone` gives the child no session file and
therefore no pi-superagents extension and therefore no `subagent` tool at all
(`session-mode.ts:244-245`, `child-runner.ts:71-75`), plus omitting `maxSubagentDepth`
because it is a global ceiling taken as `min(parent, agent)` and the docs' suggested `1`
blocks every dispatch (`shared/types.ts:511-521`).

Three workarounds against undocumented internals, in a package whose stated purpose is a
workflow we are deleting. That is a maintenance liability every time it updates.

**So: migrate.** The fallback if migration stalls is that pi-superagents *can* do this — §7
keeps the recipe — but it is a fallback, not the plan.

---

## 3. pi plugin changes

### 3.1 Package membership
`modules/devbox/plugins.nix`:

```nix
  piPackages = [
-   "git:github.com/obra/superpowers"
-   "npm:@teelicht/pi-superagents"
+   "npm:pi-subagents"
    "npm:pi-web-access"
  ];
```

Superpowers goes because we are writing our own workflow, so its 14 skills are dead weight
and the `/sp-*` entrypoints have no method left to inject. pi-superagents goes with it —
its whole value was being the delegation engine, and upstream is that engine without the
coupling.

Do it **non-destructively first**: install `pi-subagents` alongside, port one agent,
compare, then remove the other two in a second commit. The two extensions both register a
tool named `subagent`; expect a collision and settle it before deleting anything.

### 3.2 The roster
`pi-subagents` ships `scout`, `researcher`, `worker`, `reviewer`, `oracle`, `delegate` as
builtins — which covers four of our five roles out of the box. We write **one** agent, the
sub-orchestrator, at `~/.pi/agent/agents/wp.md`:

```yaml
---
name: wp
description: Runs one ledger unit of work end to end
allowNestedSubagents: true          # the whole trick, and it is a documented field
maxSubagentDepth: 1                 # its children may not delegate further
defaultContext: fresh               # fresh context per unit
thinking: xhigh
model: <orchestrator tier>
extensions: npm:pi-web-access
defaultReads: ledger/GOAL.md, ledger/PLAN.md, ledger/CONTEXT.md
---
```

and set the tiers declaratively in `modules/pi-coding-agent/settings.nix`, replacing the
`superagents.modelTiers` block:

```nix
  subagents = {
    defaultThinking = "medium";
    maxThinking = "xhigh";
    agentOverrides = {
      wp         = { model = qualified llm.default; thinking = "xhigh";  };
      reviewer   = { model = qualified llm.default; thinking = "xhigh";  };
      worker     = { model = qualified budgetModel; thinking = "medium"; };
      researcher = { model = qualified budgetModel; thinking = "medium"; };
      scout      = { model = qualified budgetModel; thinking = "medium"; };
    };
  };
```

`defaultThinking` + `maxThinking` mean the `defaultThinkingLevel = "high"` → `xhigh`
silent-escalation papercut (`agent-web-browser-toolkit.md` §8) cannot recur: there is a
declared floor and a hard ceiling, and neither depends on us remembering not to pass
`model` in a dispatch.

Note `maxThinking` interacts with our `thinkingLevels` map in `models.nix`, which already
folds `low`/`minimal` → `medium` at the chat template. Two ceilings in series; keep the
model-side map authoritative and treat `maxThinking` as a guard.

### 3.3 Web search: SearXNG, and stop pinning Exa
`modules/pi-coding-agent/settings.nix`:

```nix
  webSearch = {
    workflow = "auto-summary";
-   provider = "exa";
    curatorTimeoutSeconds = 20;
    summaryModel = qualified llm.default;
    searxngBaseUrl = "http://<searx-host>:8888";
  };
```

Dropping `provider` restores `auto`, where SearXNG is tried **first** and the rest of the
chain is the fallback. Run one instance in the `local-llm` container (not devbox — one
scraper, not one per agent), and **`search.formats` must include `json`** or every request
403s (`agent-web-browser-toolkit.md` §1-2).

Under `pi-subagents` this is the only web work left: `researcher` already declares the
tools, and `extensions:` scopes the provider per agent.

---

## 4. Model + tier changes

### 4.1 Three populations
`wp` and `reviewer` on the full window at `xhigh`; `worker` on the budget alias at
`medium`; `researcher`/`scout` on the budget alias at `medium`. Expressed as
`agentOverrides` above rather than a tier vocabulary — same three populations
`spy-hunter-orchestration-review.md` §9 identified, one fewer layer of indirection.

### 4.2 Resize the budget alias 48k → 56k
`modules/local-llm/models.nix`: replace `aliases."Qwen3.8-27B-NVFP4-48k"`
(`contextWindow = 49152`) with a `-56k` alias at `57344`. The compaction threshold moves
32,768 → 40,960 — +25% working room, so fewer build subagents reach a compaction, and one
avoided compaction is 25-40 s (`qwen38-agentic-settings.md` §11). `maxTokens` stays 8,192.

**Sized against the pool, not against the compaction win alone.** A declared window is a
compaction trigger rather than an allocation, but the *worst case* still has to fit: three
lanes at 57,344 + 8,192 is 196,608 against a measured 203,579-token pool. 81,920 — which
the source docs proposed — puts that number at 270,336, a 33% overcommit that vLLM resolves
by preempting and re-prefilling a sequence. See §12 for the full table, the two-project
case, and the conditions under which 81,920 becomes affordable.

Rename the alias key rather than editing the number in place: llama-swap's `aliases:` list
and pi's model id must move together, and a stale id then fails loudly instead of quietly
serving the wrong window.

KV sanity on a realistic wave: fresh `wp` (~15k) + `worker` (≤56k) + 2 × research (~20k)
≈ 111k of the pool. Comfortable.

---

## 5. Prompts

### 5.0 Do we need a sub-orchestrator at all?

Yes — but it is worth being precise about what it is *for*, because upstream offers two
cheaper shapes that cover part of the job.

**What it is for:** somewhere to put one unit's judgement that can then be thrown away. If
the root dispatched `worker`/`reviewer` directly, the root would hold the research, the
verdict, the diff reading and the ledger writing for every unit — which is exactly the
21 MB / 10-compaction parent from the spy-hunter run. The sub-orchestrator is not there to
add a layer; it is there to be **deleted at the end of each unit**.

Three ways to get that, and they compose rather than compete:

| Shape | What it is | Judgement | Fresh per unit |
|---|---|---|---|
| **A. `wp` agent** (chosen) | an LLM child with `allowNestedSubagents` | yes — can re-plan, add units, write the verdict | yes, `defaultContext: fresh` |
| **B. `workflowScript`** | deterministic JS inside one `subagent` call: `runs.all`, keyed children, retry, aggregation (`docs/workflows.md`) | no — branches only on `structuredOutput` fields | n/a; needs no nesting at all |
| **C. shell loop** | `pi -p` once per unit | yes (a full root) | structurally, by process exit |

**A is the answer to your requirement** — you asked for something that can add tasks,
update the ledger, and *decide*. B cannot decide; it can only sequence. C can decide but
gives up the single-UI view and re-pays root startup each unit.

**Use B inside A.** The mechanical spine of a unit — `worker` → `reviewer` → fix-`worker`
until clean or capped — is a scripted loop, and upstream ships `/review-loop` as exactly
that. Letting `wp` call a `workflowScript` for that stretch means the retry/aggregation
logic is deterministic and does not consume orchestrator reasoning; `wp` spends its
context on the parts that need a model. Keep C as the unattended fallback (§5.3).

**Missions are free, and are not the ledger.** Upstream persists JSON mission records
(objectives, run ids, artifact paths, status heartbeats) under `~/.pi/agent/missions/`
automatically. That is recovery metadata, not a charter — keep `ledger/` as the
git-tracked, human- and model-readable state, and treat missions as observability we get
without asking. `state.get`/`state.set` inside a workflow is durable JSON keyed to a
mission, useful for a retry counter; not a substitute for `CONTEXT.md`.

### 5.0a How `wp` gets written

It is one markdown file, `~/.pi/agent/agents/wp.md`, seeded from nix
(`home.file.".pi/agent/agents".source = ./agents` — store symlinks are fine here, pi only
reads agent files). Frontmatter is §3.2; the body is §5.2. Everything that makes it an
orchestrator rather than a worker is declared, not prompted:

| Requirement | Field |
|---|---|
| may delegate | `allowNestedSubagents: true` |
| its children may not | `maxSubagentDepth: 1` |
| fresh context per unit | `defaultContext: fresh` |
| judgement-grade reasoning | `thinking: xhigh` + `agentOverrides.wp.model` |
| can research the web itself | `extensions: npm:pi-web-access` |
| reads the ledger before it starts | `defaultReads: ledger/GOAL.md, ledger/PLAN.md, ledger/CONTEXT.md` |
| can commit | `tools` including `bash`, `write` |

The prose body then carries only what frontmatter cannot: the read *order* and its
rationale, the "and no more" rule, the delegation roster, the fan-out cap, and the stop
condition.

### 5.1 Root dispatcher (the interview prompt)
`spy-hunter-orchestration-review.md` §11's "improved project prompt", with the execution
clause changed because the loop is now internal:

```text
Interview me to realise the project. Then write the ledger: GOAL.md (charter),
PLAN.md (units of work + status), LEDGER.md (append-only log), CONTEXT.md
(live state), tasks/NNN-slug.md (one per unit: brief, findings, verdict).
The test is: I can kill you at any unit boundary and a fresh agent resumes
from these files alone.

After the interview YOU DO NO WORK. Your only actions are:
  subagent { agent: "wp", task: "Run the next todo unit in ledger/PLAN.md" }
  ...then read ONLY the returned summary, and dispatch the next one.
Never read a diff, a report file, or source.
Stop when PLAN.md has no todo units, or when wp returns a blocked verdict
twice in a row.
```

### 5.2 `wp` body (the sub-orchestrator)
```text
You run exactly ONE unit of work, then stop. You are disposable; the ledger
is the memory.

READ, IN THIS ORDER, AND NO MORE
1. ledger/GOAL.md        2. ledger/PLAN.md
3. `tail -60 ledger/LEDGER.md`   4. ledger/CONTEXT.md
5. the task file for this unit only.
Stable files before volatile ones — CONTEXT.md is rewritten every unit, so
reading it earlier invalidates everything behind it in the prefix cache.

RECOVER: `git status` / `git diff --stat`. Decide complete, partial, or
discard, and log that decision before anything else.

THEN: research -> build -> review -> integrate.
- Delegate the build: subagent { agent: "worker", ... }. You do not write
  feature code.
- Delegate research: subagent { agent: "researcher", ... } — it has web
  access; spend those tokens off your context.
- Delegate the mechanical review: subagent { agent: "reviewer", ... }. The
  verdict is yours.
- Fan out at most 2, and only for independent read-only work.

You may add or re-scope units in PLAN.md if the work demands it; say so in
your report.

BEFORE YOU STOP: update PLAN.md, append to LEDGER.md, rewrite CONTEXT.md,
commit, push. Report ONLY: unit id, verdict, commit SHAs, one-line test
summary, concerns, exact next action. If you approach compaction, checkpoint
to CONTEXT.md and stop — a fresh session is cheaper than a summary.
```

`defaultReads` covers items 1, 2 and 4 declaratively; keep the prose because it also
carries the *ordering* rationale and the "and no more" rule.

Also amend `ledger/README.md`'s recovery order to
`GOAL → PLAN → LEDGER (tail) → CONTEXT → task file` (§10 of the review).

### 5.3 Keep the shell loop as the fallback
`spy-hunter-orchestration-review.md` §12's `run-ledger.sh` stays the belt-and-braces
answer: `pi -p` per unit is *structurally* fresh, where the root dispatcher is only
fresh-by-discipline. Build the in-pi version for the single-UI view, keep the loop for
unattended runs, and keep its HEAD-advance stall check — the only honest progress signal.

---

## 6. vLLM changes, in commit order

Independent of the plugin work; items 1-3 can land first. One commit each.

1. **`supportsThinkingTokenBudget = false`** (`settings.nix:98`). One line. vllm#44676 is
   open on our exact parser pair (`qwen3_coder` + `qwen3`): the budget holder counts
   tool-call argument tokens as thinking and force-injects `</think>` into the middle of
   the JSON arguments. Reporter's differential: small budget 3/4 runs corrupted, large
   0/8, off 0/12. Control thinking via `reasoning_effort`, which cannot corrupt a tool
   call. **Do this before the nested design ships** — the fan-out is where the tool calls
   are, and the budget alias's 7,168 is the exposed one.
2. **`--max-num-batched-tokens` 2048 → 8192** (`models.nix` `vllm.maxNumBatchedTokens`).
   Prefill dominates our turns (20-40k prompts inside single 10-second windows), and it is
   a prerequisite for step 4's `align` assert (`block_size <= max_num_batched_tokens`).
   Watch the startup line *"Setting attention block size to N tokens"*; keep the flag ≥ N.
3. **Delete the stale `--override-generation-config` comment** (`llama-swap.nix:52-54`) —
   for 3.8 it pins a value identical to the repo default. Comment only.
4. **Measure prefix caching; do not assume it.** `--enable-prefix-caching
   --mamba-cache-mode align`, MTP kept. Long prompt twice, read
   `vllm:prefix_cache_hits_total`. Known outcomes on this checkpoint: full (v0.24.0),
   partial ~42% (0.27.1-era), zero and silent (nightly) — **we are on v0.26.0 and nobody
   has measured it**. Then watch for `!!!!` / empty responses the whole time it is on:
   vllm#53912 measured 0.95% malformed at 0.26.0 with APC+MTP, which is very likely what
   `models.nix:157` recorded on 3.6. **Never trade MTP away for caching** — MTP is ~3.7×
   decode and the swap is a net loss.
5. **A/B `speculativeTokens` 3 → 4.** Position-3 acceptance is still 0.85-0.99. Compare
   *mean acceptance length*, not rate. Do not jump to 5 (repeated-token loops at MTP5).
6. **Vision — deferred, not dropped.** `--limit-mm-per-prompt '{"image":1,"video":0}'`,
   `--mm-processor-kwargs '{"max_pixels": 1048576}'`, `--mm-processor-cache-gb 1`. The
   startup OOM was a 16.78 MP profiling default, not the card. Lands **with**
   `webcheck --screenshot`, not before.
7. **`--max-num-seqs` 3 → 6 — gated, disposable session.** vllm#54331: sm_120 +
   hybrid-GDN NVFP4 + CUDA graphs SIGSEGVs after 7-8 minutes of sustained multi-lane load,
   first appearing in 0.26.0; only `--enforce-eager` survives. We have not hit it because
   we run at `Running: 1`, and the depth-2 tree is exactly what starts driving real
   concurrency. Watch for `EngineDeadError`.

Not doing: migrating to NInfer (checkpointing anchors on human turns; agent loops have
none — 16% of requests at 30-36 s on our exact workload), dropping llama-swap (no perf
benefit), widening fan-out past 3, lowering temperature.

---

## 7. Fallback: staying on pi-superagents

If the migration stalls, the current stack does support the design — with the three
workarounds from §2, which are only safe written down:

- name the sub-orchestrator **without** an `sp-` prefix, or `resolveRoleTools` strips its
  `subagent` tool;
- `session-mode: lineage-only` (not `standalone`, which yields no session file and hence
  no delegation tool);
- **omit** `maxSubagentDepth` on it (inherit the default 2); `1` blocks every dispatch;
- give it `extensions: npm:pi-web-access`, and expect to restate the roster in its brief,
  because the bundled tool description tells the model that bounded roles may not delegate
  and that delegation belongs to a Superpowers workflow that no longer exists.

---

## 8. `webcheck`

A `chromium` / `playwright-driver` script on PATH inside devbox, text-first: DOM, a11y
tree, console errors, failed requests. No plugin needed — the agent drives it over bash.
`--screenshot` second, paired with §6 item 6. Independent of everything above.

---

## 9. Sequence

| # | Change | Verify |
|---|---|---|
| 1 | `supportsThinkingTokenBudget = false` | a long file-write tool call survives intact |
| 2 | `--max-num-batched-tokens` 8192 | startup block-size line |
| 3 | install `pi-subagents` alongside; port `wp`; **resolve the `subagent` tool-name collision** | `subagent { agent: "scout" }` runs |
| 4 | `wp` dispatches `worker` — **the depth test** | a depth-2 child completes and reports |
| 5 | remove superpowers + pi-superagents from `piPackages` | no orphaned config; tool registry clean |
| 6 | `agentOverrides` tiers + `-80k` alias | `/subagents` status shows the right model and level per role |
| 7 | SearXNG + drop `provider = "exa"` | `researcher` returns a citation it could not have found locally |
| 8 | prefix-caching measurement | `prefix_cache_hits_total` > 0, no `!!!!` |
| 9 | first real ledger run under the nested design | zero compactions per `wp`; root stays < 20k |
| 10 | `speculativeTokens` 4, then `max-num-seqs` 6 | mean acceptance length; `EngineDeadError` watch |
| 11 | `webcheck` text mode, then vision + `--screenshot` | — |

Step 4 is the gate. If a depth-2 child cannot run on `pi-subagents` for a reason not
visible in its docs, the choice is §7's workaround stack or §5.3's shell loop — the loop
needs no nesting at all and delivers the same freshness guarantee with less leverage.

## 10. What success looks like

The measured baseline: a 21 MB parent with 10 compactions spent 1-2 hours of 18
re-prefilling ~90k tokens at a 0% cache hit rate. Under this design the root never exceeds
~20k, each `wp` starts near 15k and dies before it compacts, and research runs off the
critical path. If a `wp` compacts, that unit was too big — split it, which is the
compaction-breaker rule already in the ledger charter.

---

## 11. Consolidated change list

Every change, what it touches, and why. **M** = measured effect available, **E** = estimate.

### A. Orchestration (the new capability)

| # | Change | File(s) | Effect |
|---|---|---|---|
| A1 | Install upstream `pi-subagents`; remove superpowers + `@teelicht/pi-superagents` | `modules/devbox/plugins.nix` | nesting becomes a documented field instead of three workarounds (§2) |
| A2 | Write **one** agent, `wp` (the sub-orchestrator) | new `modules/pi-coding-agent/agents/wp.md`, linked by `home.nix` | a disposable context per unit of work — the fix for the 21 MB parent |
| A3 | Adopt builtin `scout` / `researcher` / `worker` / `reviewer` | none — they ship | four roles we do not have to author or maintain |
| A4 | Root dispatcher prompt: dispatch-only, never read a diff | ledger repo, `ledger/ORCHESTRATOR.md` | **M** root grows ~200 tokens/unit instead of toward the 94,208 compaction threshold |
| A5 | `wp` body: read order, roster, fan-out cap, stop rule | same file | context discipline the frontmatter cannot express |
| A6 | Use a `workflowScript` for the worker→reviewer→fix loop inside `wp` | `wp` body | deterministic retry/aggregation without spending orchestrator reasoning |
| A7 | Keep `run-ledger.sh` as the unattended fallback | ledger repo | structural freshness if A2 disappoints |

### B. Model routing and context budgets

| # | Change | File(s) | Effect |
|---|---|---|---|
| B1 | `agentOverrides.{wp,reviewer,worker,researcher,scout}.{model,thinking}` replaces `superagents.modelTiers` | `modules/pi-coding-agent/settings.nix` | per-role tiering that survives the plugin swap |
| B2 | `subagents.defaultThinking = "medium"`, `maxThinking = "xhigh"` | same | **M** kills the silent `high`→`xhigh` escalation on the fan-out (`toolkit` §8) |
| B3 | Budget alias `-48k` → `-56k` (`contextWindow` 49,152 → 57,344; **not** 81,920 — see §12) | `modules/local-llm/models.nix`, `llama-swap.nix` alias list | compaction threshold 32,768 → 40,960 while a full 3-wide wave still fits the KV pool |
| B4 | Delete the dead `balanced` tier | `settings.nix` | nothing referenced it |

### C. Prefix caching — yes, it is in the plan, as a measurement

| # | Change | File(s) | Effect |
|---|---|---|---|
| C1 | `--enable-prefix-caching --mamba-cache-mode align`, MTP kept | `modules/local-llm/llama-swap.nix` | **M** on this checkpoint: 7.27 s → 1.33 s TTFT on v0.24.0; **unmeasured on our v0.26.0** — three known outcomes (full / ~42% / zero-and-silent) |
| C2 | `--max-num-batched-tokens` 2048 → 8192 | `models.nix` | required for C1's `block_size <= max_num_batched_tokens` assert; **E** 10-30% off prefill independently |
| C3 | Watch `vllm:prefix_cache_hits_total` and for `!!!!`/empty responses | ops, not config | **M** vllm#53912: 0.95% malformed at 0.26.0 with APC+MTP, rate tracks hit rate. Revert trigger |
| C4 | `--prefix-match-unit` **only if** C3 shows low hit rates | `llama-swap.nix` | fp8 KV inflates the block size; this sets a finer match boundary |
| C5 | Ledger read order → stable-before-volatile (`GOAL → PLAN → LEDGER tail → CONTEXT → task`) | `ledger/README.md`, `wp` body, `defaultReads` | the change that makes C1 *compound*: consecutive `wp` runs then share a byte-identical prefix |

**Why C and A are the same project.** `CONTEXT.md` is rewritten every unit, so the current
read order invalidates everything behind it on every single run. Fix the order and give
every `wp` identical frontmatter (same tools, same effort ⇒ same system block), and each
fresh sub-orchestrator hits cache on nearly its whole preamble instead of re-prefilling
~15k. Fresh-context-per-unit and prefix caching only compound if C5 lands with A2.

**What we explicitly do not do:** disable MTP to get clean caching. MTP is worth ~3.7× on
decode; the trade makes a representative turn *slower than today* (20 s → 36 s).

### D. Web and research

| # | Change | File(s) | Effect |
|---|---|---|---|
| D1 | Self-hosted SearXNG, `search.formats` including `json` | new module, `local-llm` container | removes the only metered dependency; **M** ends the standing "web_search rate-limited" fact |
| D2 | Drop `provider = "exa"`; set `searxngBaseUrl` | `settings.nix` `webSearch` | restores `auto`: SearXNG first, fallback chain intact |
| D3 | `extensions: npm:pi-web-access` on `wp`; builtin `researcher` already declares the tools | `wp.md` | **M** fixes "no subagent has web access at all" — the thing pinning research to the parent |

### E. vLLM tuning

| # | Change | File(s) | Effect |
|---|---|---|---|
| E1 | `supportsThinkingTokenBudget = false` | `settings.nix:98` | **M** vllm#44676: budget exhaustion injects `</think>` into tool-call JSON. 3/4 runs corrupted at small budgets, 0/12 with thinking budget off |
| E2 | Delete the stale `--override-generation-config` comment | `llama-swap.nix:52-54` | comment only; it claims to pin a value identical to the default |
| E3 | A/B `speculativeTokens` 3 → 4 | `models.nix` | **E** 5-10%; compare mean acceptance length, not rate. Do not jump to 5 |
| E4 | `--max-num-seqs` 3 → 6 — **gated, disposable session** | `models.nix` | vllm#54331: sm_120 + NVFP4 + CUDA graphs SIGSEGV under sustained concurrency. The depth-2 tree is the trigger condition |
| E5 | Vision: `image:1`, `max_pixels: 1048576`, `mm-processor-cache-gb 1` | `llama-swap.nix` | **M** root cause of the startup OOM was a 16.78 MP profiling default, not the card. Lands with F1 |

### F. Browser toolkit (independent)

| # | Change | File(s) | Effect |
|---|---|---|---|
| F1 | `webcheck` text mode: DOM, a11y tree, console, failed requests | `modules/devbox/container.nix` + a script | no plugin needed; an LLM reasons better over `width: 0px` than over pixels |
| F2 | `webcheck --screenshot`, paired with E5 | same | the only channel for canvas/WebGL — the current hard human gate |

### Not doing

Migrating to NInfer (**M** 16% of requests at 30-36 s on our exact workload — its
checkpointing anchors on human turns and agent loops have none) · dropping llama-swap (no
perf benefit) · widening fan-out past 3 (serial graph, server saturates near 4) · lowering
temperature (1.0 is the model card's thinking-mode value) · `@gotgenes/pi-subagents` (hard
recursion guard, §1).

### Order

E1, E2 (free, today) → C2 → A1, A2, A3 (the depth test gates everything) → B1-B4 →
D1-D3 → C1, C5 + C3 watch → A4-A7 first real run → E3 → E4 (disposable session) →
F1 → E5 + F2.

---

## 12. Two projects at once, and what the KV pool actually bounds

### Session count does not enter the KV math

`--max-num-seqs 3` is a **server-wide** cap, not per session, and queued requests hold no
KV — blocks are allocated when a sequence is *scheduled*, not when it is submitted. So:

> Ten open pi sessions across four projects still put at most **three** sequences in the
> KV pool at once. Extra sessions buy queueing latency, never memory pressure.

Two projects each running a root + `wp` + a worker cannot thrash the cache. They contend
for three lanes and vLLM serialises the excess.

### The real cost is throughput, and it is not free

One GPU, one resident model. **M**: C=4 is the measured peak and C=8 is *slower* than C=4,
so total work per hour is roughly constant. Two busy projects therefore approximately halve
each other's wall clock — the second project is not free, it is a split of the same box.

That argues *for* the ledger design rather than against two projects: a unit of work that
is disposable and resumable from files is exactly what you want when its lane is shared.

### What the pool does bound: a full-width wave at full window

Measured pool: **203,579 tokens** (fp8 KV, `maxModelLen` 131,072, `gpu-memory-utilization`
0.94). A lane can hold up to its model entry's declared window plus its output allowance:

| Fan-out alias `contextWindow` | 3 lanes at full window | vs 203,579 pool |
|---:|---:|---|
| 49,152 (today) | 3 × 57,344 = **172,032** | fits — this is why the alias was sized here |
| 57,344 | 3 × 65,536 = **196,608** | fits |
| 65,536 | 3 × 73,728 = 221,184 | 9% over |
| **81,920 (§4.2 as drafted)** | 3 × 90,112 = **270,336** | **33% over** |

**This corrects B3 / §4.2.** Raising the fan-out alias to 80k breaks the invariant the
alias exists to hold. It is not a crash — vLLM preempts by *recomputation*, dropping a
sequence's KV and re-prefilling it later — but that is precisely the expensive event this
plan exists to eliminate, so trading a possible 25-40 s compaction for a possible 90k
re-prefill is not obviously a win.

Revised, in order of preference:

1. **`57,344`** — keeps a full 3-wide wave strictly inside the pool (196,608) while moving
   the compaction threshold 32,768 → 40,960 (+25% working room). Safe with two projects,
   no conditions attached.
2. **`81,920` only after C1 shows real prefix-cache hits** — with APC a same-role fan-out
   shares one copy of the system block and repo preamble instead of three, which is what
   would make the wide window affordable. That dedup does **not** help across two
   *different* projects, which share no prefix.
3. Keep 49,152 if C1 comes back at zero hits.

Realistic mixed waves sit well inside the pool either way — a fresh `wp` (~15k) + a worker
(≤80k) + a researcher (~20k) ≈ 115k — so the binding case is the tail, not the average.
Measured steady-state usage is 10-25% of the pool.

### The "100k" is intact

Stated explicitly, because these numbers move around between docs:

| Entry | `contextWindow` | Compacts at | Who runs there |
|---|---:|---:|---|
| `Qwen3.8-27B-NVFP4` | **110,592** (unchanged) | 94,208 | root dispatcher, `wp`, `reviewer` |
| fan-out alias | 49,152 → 57,344 | 32,768 → 40,960 | `worker`, `researcher`, `scout` |

The judgement agents keep the full ~110k window. The 80k number was only ever about the
*fan-out alias*, and this section revises it down.

### Operating rules for two concurrent projects

- **Fan out ≤ 2 per project** when a second project is active. Three lanes total, and the
  server peaks near four.
- **Do not raise `--max-num-seqs` (E4)** while running two projects. The 3-lane cap is
  doing real work as a governor here, and E4 is independently the trigger for the sm_120
  CUDA-graph SIGSEGV.
- **Read queueing correctly.** A `wp` that looks slow while another project is mid-build is
  waiting for a lane, not stuck. `vllm:num_requests_waiting` tells them apart.
- **One llama-swap instance, one model** — both projects hit the same resident vLLM, so
  there is no model swap and no cold start between them. Two projects are cheap to *have*,
  just not cheap to *run simultaneously*.

---

## 13. Decommission list — what gets removed, and what removing it does not clean up

Swapping the delegation plugin leaves state in five places. A rebuild re-seeds *membership*
but never uninstalls, so most of this needs one explicit action each.

| # | Remove | Where | Note |
|---|---|---|---|
| G1 | `git:github.com/obra/superpowers` | `modules/devbox/plugins.nix` `piPackages` | the 14 skills and `/sp-*` entrypoints; nothing we keep references them |
| G2 | `npm:@teelicht/pi-superagents` | same list | replaced by `npm:pi-subagents` (A1) |
| G3 | the whole `superagents = { superagents = { modelTiers … } }` block | `modules/pi-coding-agent/settings.nix` | replaced by the `subagents` block in B1 |
| G4 | the dead `balanced` tier | inside G3's block | no bundled or custom agent ever referenced it |
| G5 | `~/.pi/agent/npm/node_modules/@teelicht/*` and the superpowers clone | container state, not nix | **a rebuild does not do this.** Removing a spec from `piPackages` changes what is seeded into `settings.json`; it does not uninstall. Run `pi remove` for each, or rebuild the container from scratch, and verify `~/.pi/agent/npm/node_modules` afterwards |
| G6 | `config.json.bak-<timestamp>` files | `~/.pi/agent/extensions/subagent/` | left by pi-superagents' install migration; two on this box today, mode 444. Nothing prunes them |

### What to keep, deliberately

- **The `home.activation.piSuperagentsConfig` mechanism.** `pi-subagents` reads config from
  the *same path* — `~/.pi/agent/extensions/subagent/config.json`. Retarget the content,
  keep the copy-not-symlink activation and its EROFS rationale intact; the new extension
  rewrites that file at startup for the same reasons. Rename the nix binding
  (`superagentsConfig` → `subagentsConfig`) so the name stops lying.
- **`pi-web-access`.** Same author as `pi-subagents`; the bundled `researcher` is written
  around its tools.
- **The `Qwen3.6-27B-NVFP4` catalog entry.** Not in `enabled`, so no weights are fetched
  and it costs nothing — `models.nix` is a catalog by design and the 3.6 entry documents
  the settings that differ (temperature 0.6, `qwen3_xml` parser). Its
  `# Prefix caching off: caused incoherent rewrite loops` note becomes *evidence* once C3
  runs, not dead weight.
- **`nodejs` + `bun` in `extra-packages.nix`.** `bun` is `npmCommand`; both stay.

### One decision for you: the claude-side superpowers plugin

`plugins.claudePluginId = "superpowers@claude-plugins-official"` (`plugins.nix`, seeded
into claude's `enabledPlugins` at `container.nix:69-71`) is **a different plugin for a
different agent**. Dropping pi-side superpowers does not touch it, and these spec documents
live under `docs/superpowers/specs/` by its convention.

Recommendation: **keep it** unless you have also stopped using claude's superpowers skills.
It is independent of everything in this plan. If you do want it gone, it is two lines —
the `claudePluginId` binding and the `enabledPlugins` entry — plus claude-owned state
(marketplace clone, plugin cache, `installed_plugins.json`) that nix never wrote and will
not clean.

---

## 14. Prefix caching: an instrument, not a one-off measurement

C1 asked "does it work here". This section is the standing answer to "**how well, and when
does it degrade**" — because on this checkpoint the failure modes are silent (zero hits,
no warning) or statistical (~1% malformed responses), and neither shows up as an error.

### C6 — a probe script

`vllm-cache-probe`, on PATH in the `local-llm` container, hitting vLLM directly at
`http://192.168.100.24:5800/metrics` (llama-swap proxies `/v1`, so do not assume `/metrics`
is reachable through 8081):

```
vllm-cache-probe            # hit rate since boot, and delta since the last run
vllm-cache-probe --ab       # send one long prompt twice, report TTFT1, TTFT2, hits gained
```

Read the `vllm:prefix_cache_*` counters (`queries_total` / `hits_total`) — **confirm the
exact metric names against `/metrics` on our build first**, they have been renamed across
vLLM versions. Hit *rate* is the derived ratio; store the previous counters in a state file
so the delta reflects recent work rather than lifetime average.

### C7 — the three-arm A/B, so we learn the shape and not just a number

Run the same long prompt twice per arm, on an idle server:

| Arm | Config | What it tells us |
|---|---|---|
| 1 | APC off (today) | the baseline TTFT we are trying to beat |
| 2 | **APC on + MTP k=3** | the arm we actually want to ship |
| 3 | APC on, MTP off | isolates whether MTP is what breaks caching here |

Arm 3 is diagnostic only — **we do not ship it** (MTP is ~3.7× decode; giving it up makes
a representative turn slower than today, 20 s → 36 s). Its purpose is to distinguish "APC
is broken on 0.26.0" from "APC + MTP interact", which is the difference between waiting for
vLLM PR #52244 and reverting permanently. Published reference points on this exact
checkpoint: v0.24.0 full (TTFT 7.27 s → 1.33 s), 0.27.1-era partial (69.4% → 42.5% with
MTP), nightly zero and silent.

### C8 — the degradation canary, running continuously

vllm#53912's signature is responses that degenerate into repeated `!` or come back empty,
and **the corruption rate tracks the cache hit rate** — so it appears as caching starts
working, not when it fails. Grep the session JSONL for it:

```
grep -lE '"text":"!{20,}"|"text":""' ~/.pi/agent/sessions/**/*.jsonl
```

Run it per unit of work (it is cheap) and record the count alongside the hit rate. Two
numbers, same row: **hit rate up with malformed at zero is the win; both rising together is
the bug.** That pairing is the whole point — either number alone is uninterpretable.

If it fires, that also retroactively confirms `models.nix:157`'s note about 3.6 rewrite
loops was this bug rather than a misconfiguration, which is worth writing back into the
catalog comment.

### C9 — per-unit visibility

`pi --mode json` emits `compaction_start` / `compaction_end`. Have the loop (or `wp`) log
per unit: hit rate, malformed count, compaction count, wall clock. That turns "the parent
got huge" — previously findable only by grepping a 21 MB session file — into a per-unit
alarm, and it is the same table that tells us whether C5's stable-first read order actually
bought the shared prefix it predicts.

### Decision rule, written down before we look

| Observation | Action |
|---|---|
| hits ≈ 0 | revert APC; watch vLLM PR #52244. Costs nothing to have tried |
| partial hits (~40%), malformed 0 | **keep** — still a win per the turn-cost table (~15.5 s vs ~20 s) |
| full hits, malformed 0 | keep, and revisit the 81,920 alias (§12) |
| malformed > 0 at any hit rate | revert APC, regardless of the speedup |
| hits low *and* prompts long | try `--prefix-match-unit` (C4) before concluding — fp8 KV inflates the block size |

Committing to that table in advance is what stops a 1%-corruption rate being rationalised
later as "probably the model having a bad day".

---

## 15. As built — where the recipes above were wrong

Implemented on branch `plan/nested-orchestrator`. The decisions in §1-§4 hold;
four of the concrete recipes did not survive contact with `pi-subagents@0.61.0`'s
actual sources, and are recorded here so a later reader does not reintroduce them
from the draft frontmatter in §3.2.

**`maxSubagentDepth: 1` on `wp` blocks every dispatch `wp` makes.** §3.2 annotates
it "its children may not delegate further". It does not mean that. When the parent
spawns an agent, `resolveChildMaxSubagentDepth(parentMax, agentConfig.maxSubagentDepth)`
mins the two and `getSubagentDepthEnv` hands the result to that agent as its *own*
`PI_SUBAGENT_MAX_DEPTH`, alongside `PI_SUBAGENT_DEPTH=1`. `checkSubagentDepth` then
blocks at `depth >= maxDepth`, so `wp` would be capped at the depth it already
occupies — structurally the same trap as pi-superagents' `sp-` prefix in §2, in the
package chosen to avoid it. The default `DEFAULT_SUBAGENT_MAX_DEPTH = 2` already
produces exactly the wanted shape: `wp` at depth 1 can dispatch, its children at
depth 2 cannot. Stated explicitly as `maxSubagentDepth: 2` in the extension config
so the invariant does not ride on an undocumented default.

**`extensions: npm:pi-web-access` would have removed `wp`'s web access, not granted
it.** The field is an allowlist of extension *paths*, and `docs/agents.md` is
explicit that "when `extensions` is present, normal discovered extensions are
disabled". An npm spec is not a path, so the entry resolves to nothing while still
disabling everything else. Omitted — which is the documented way to keep all
ambient extensions, `pi-web-access` included.

**The tiering block is a pi *settings* key, not extension config.**
`docs/configuration.md:5` splits them: `subagents.{defaultModel, defaultProvider,
defaultThinking, defaultExtensions, agentOverrides, modelScope, disableThinking,
disableBuiltins}` are read from the pi settings files, and only the remaining keys
from `~/.pi/agent/extensions/subagent/config.json`. §13's instinct to keep the
copy-not-symlink activation is still right — upstream's `updateConfig` read-modify-
writes that same path — but what it carries is now just `maxSubagentDepth`.

There is also a precedence asymmetry worth knowing before moving a field between
`wp.md` and `settings.nix`: for **builtins**, `agentOverrides` replaces frontmatter
outright (`applyBuiltinOverride`), which is how `worker` drops from its bundled
`thinking: high` and `scout` rises from `low`. For **custom** agents it only *fills*
fields the frontmatter left unset (`applyCustomAgentOverride`, guarded by
`agentHasFrontmatterField`). So `wp.md` deliberately declares neither `model` nor
`thinking`.

**D1 (self-hosted SearXNG) was dropped, and D2 was not what it looked like.** Two
findings killed it.

D2 as written — delete `provider = "exa"` and let `auto` take over — is a no-op.
`auto` returns the *first available* provider from a fixed priority order, and
`isExaAvailable()` is hardcoded `return true`, so with no API key set and no SearXNG
URL, `auto` resolves to exa on every call. The pin was never what put us on exa.
`"all"` is not the answer either: it fans out, but over a list that explicitly
excludes `duckduckgo`, `anysearch` and `parallel-mcp`, so it also collapses to exa.

D1 would have fixed that, but at a price the plan does not price in. `pi-web-access`
runs every fetch through `assertPublicAddress`, whose IPv4 blocklist covers *all*
private space — `100.64.0.0/10` (tailscale CGNAT) **and** `192.168.0.0/16`. So there
is no address a self-hosted instance could live at that does not need an
`ssrf.allowRanges` exemption, and `allowRanges` is global: `extract.ts`
(`fetch_content`) reads the same config, so exempting a range also lets an
attacker-controlled page redirect the agent into it. Add to that SearXNG's own
suspension schedule — 180s on HTTP 429, 1 hour on a CAPTCHA, **15 days** on a
Cloudflare CAPTCHA — against a workload that is precisely bursty automated querying
from one IP, and self-hosting trades a metered dependency for an unmetered but
markedly less reliable one, plus a scraper to maintain.

What landed instead is the explicit list `["exa", "duckduckgo", "anysearch",
"parallel-mcp"]` — every provider that works without a key, queried in parallel and
merged with URL dedup. Failures are per-provider (they become a "Provider errors"
note; only an all-provider failure throws), so a throttled exa thins the results
rather than blocking research. Buying a key later is appending a name to that list.

One residual worth recording: in the `auto` path pi-web-access *does* fail over
between providers at query time, but a provider returning HTTP 200 with zero results
counts as success and does not trigger fallthrough. Under the explicit list that
matters less, since the merge already spans four providers.

### Landed

E1, E2, C2 · A1, A2, A3, A5, C5 (read order, in `wp.md` and `defaultReads`) ·
B1-B4 · B3 at 57,344 per §12 · D3, and D2 as a multi-provider list rather than as
an unpin · the §13 decommission list, minus the container-state items nix cannot do
(G5) — G6's `.bak` sweep is now in the activation.

§13's open question is answered the other way: **the claude-side superpowers plugin
goes too.** `claudePluginId` and the `enabledPlugins` entry are gone, so a rebuilt
container comes up with no claude plugins at all. That only stops nix *enabling*
it — claude's own state is untouched, and `claude plugin uninstall` /
`marketplace remove` is a manual step, recorded in `container.nix` next to the seed
it replaces. `docs/superpowers/specs/` keeps its name; it is just a directory now.

The G5 cleanup runbook lives in `plugins.nix`'s header, next to the membership list
whose editing is what creates the mess — including the ordering trap, since nix
re-seeds `settings.json` on every activation and pi reinstalls anything missing, so
deleting files before dropping the spec just invites the package back.

### Not landed, and why

- **C1, C3-C4, C6-C9 (prefix caching).** §14 writes the decision rule *before*
  looking, and its own table says to revert on any malformed output. Turning APC on
  in nix ahead of the measurement inverts that. C2 lands here because it is the
  precondition (`block_size <= max_num_batched_tokens`) and is worth having on its
  own.
- **E3 (`speculativeTokens` 4), E4 (`--max-num-seqs` 6).** Both are A/Bs, and E4 is
  explicitly "gated, disposable session" against vllm#54331.
- **E5, F1, F2 (`webcheck`, vision).** §8 calls the browser toolkit independent of
  everything above, and E5 is deferred until it pairs with `--screenshot`. Separate
  change.
- **A4, A6, A7.** These live in a project's ledger repo, not in nixcfg. The root
  dispatcher prompt stays here in §5.1. It does not belong in
  `modules/devbox/ENVIRONMENT.md`, which is `--append-system-prompt` for claude and
  `APPEND_SYSTEM.md` for pi - a workflow prompt there is paid for by every session
  of both agents, including the ones not running it.
- **D1 (self-hosted SearXNG).** Dropped on the evidence above: it cannot be reached
  without widening the SSRF guard for every fetch, and its engine-suspension
  penalties run to days against exactly this workload. Revisit if the keyless
  providers throttle in practice; the cheaper next step is an API key.

### Step 4 is still the gate

Nothing above proves a depth-2 child runs. The first thing to do on the rebuilt
container is `subagent { agent: "wp", task: ... }` and watch `wp` dispatch a
`worker`. If it cannot, the fallbacks are unchanged: §7's workaround stack or §5.3's
shell loop.

### Rollout order on a running container

A rebuild seeds membership; it never uninstalls. So:

1. Rebuild, then `pi remove git:github.com/obra/superpowers` and
   `pi remove npm:@teelicht/pi-superagents`, and check
   `~/.pi/agent/npm/node_modules` is actually clear of `@teelicht`.
2. Restart pi. Both extensions register a tool named `subagent`; if the old one is
   still installed, expect the collision §3.1 predicted.
3. `/subagents` (or `subagent { action: "list" }`) should show `wp` alongside the
   six builtins, each on the model and thinking level from `agentOverrides`.
4. Then the depth test.
