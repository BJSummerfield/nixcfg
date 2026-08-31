# spy-hunter-vibe: where the 18 hours goes, and whether fan-out helps

**Date:** 2026-08-30
**Subject:** `~/projects/spy-hunter-vibe`, branch `feat/spyhunter-parity`,
worktree `/var/lib/paseo/worktrees/25trkhou/mundane-horse`
**Status:** review only — nothing in that repo was touched (a live agent is working there).

## 1. The setup is good

Worth saying first, because the recommendations below are all about *scheduling*, not design.
`ledger/` is a genuinely well-built file-based memory: `GOAL.md` charter, `CONTEXT.md` live
state, `LEDGER.md` append-only event log, `PLAN.md` work packages, `tasks/NNN-slug.md` per WP.
Verification is pixel assertions on rendered frames rather than eyeballing. Briefs are kept
compact on purpose. Frame pins (1312/1677) are re-verified by the parent independently, twice.

That discipline is why an 18-hour autonomous run has produced coherent, reviewed work instead
of drift.

## 2. Measured pace

From `git log` on the branch, per work package, brief → build → review → ledger:

| WP | Wall clock | Note |
|---|---:|---|
| W25a vehicle art | 38 min | + parent-side van-tire fix |
| W25b HUD/road art | 69 min | |
| W26 audio | 24 min | |
| W27 mobile touch | 15 min | |
| W28a player anchor | 64 min | |
| W28b territories/forks/ice | 92 min | 12 min of it parent research |
| W29 boat mode | **167 min** | the outlier |
| W30 pixel suite | in flight | dispatched 18:33 |

10:24 → 18:33 is **8h09m for seven work packages**, mean ~70 min. The shape inside each is
consistent: parent research/brief 6–12 min, **subagent build 20–140 min (dominant)**, parent
review 6–21 min, integration 1–2 min.

## 3. The finding: the parent is re-reading itself

The parent's pi session:

```
/home/agent/.pi/agent/sessions/--var-lib-paseo-worktrees-25trkhou-mundane-horse--/
  2026-08-30T06-08-20-676Z_01a05148-....jsonl   21 MB, 1,003 lines
```

One continuous session since 06:08Z, still writing at 18:33. It contains
**10 `"type":"compaction"` events.**

Two costs, and the second is much larger than the first:

1. **The compactions themselves.** Per `2026-08-30-qwen38-agentic-settings.md` §11, one
   compaction is a full prefill of the history being summarized + a summary generation (capped
   at 13,107 tokens) + a re-prefill of the compacted context next turn — call it 25–40 s.
   Ten of those is 4–7 minutes, plus information loss.
2. **Everything between them.** A session that compacts ten times spends most of its life near
   the compaction threshold — `contextWindow - reserveTokens` = 110,592 − 16,384 = **94,208
   tokens**. With `Prefix cache hit rate: 0.0%` (measured, §4), **every parent turn re-prefills
   ~90k tokens**. At the measured ~3,500 tok/s that is **~26 s per turn**, against ~4 s for a
   fresh 15k-token parent.

Across a few hundred parent turns that is on the order of **1–2 hours of the 18 spent
re-reading context the model already had.** That is the single biggest recoverable cost here,
and it needs no config change at all.

## 4. Would fan-out help? Mostly no — the graph is serial

The build chain W20 → W21 → W22a → W22b → W23 → W24a → W24b → W25a → W25b → W26 → W27 →
W28a → W28b → W29 → W30 is a straight line, and not by accident:

- every WP edits the same `crates/domain` and `crates/renderer`;
- every WP re-verifies the **same frame baselines** (idle 1677 / throttle 1312 / gear 1677,
  fork 792@1150, water-run 792). Two builds in flight produce baselines against different
  bases, which makes both meaningless.

Worktree isolation does not fix this — it defers the conflict to merge time and leaves the
pins uncomparable. `GOAL.md`'s "fan-out ≤ 2–3" is already the right call, and §12 shows the
server itself saturates around 4 lanes anyway. **Widening the fan-out is not the lever.**

Where parallelism *is* actually available:

- **Research phases.** W33 (opening sequence + count-time lives) and W34 (scoring fine-tune)
  are both `todo`, both need research, and both are independent of each other and of W30/W31.
  Read-only, markdown output, zero code conflict. That is a legitimate 2-wide fan-out today.
- **Review ⟂ next research.** The parent spent 18:09 → 18:30 reviewing W29 with nothing else
  running. W33/W34 research could have overlapped it.
- **Inside a large build, after the domain lands.** W29 was 140 minutes in one subagent
  covering domain sim + renderer sprites + smoke checks. Those are file-disjoint, but the pins
  depend on the domain, so the only safe split is: domain first, then renderer + smoke 2-wide.
  Worth trying on W33, which has a similar shape.

## 5. The parent is doing work it does not have to

From `CONTEXT.md` and `LEDGER.md`, the parent personally did: W24 research (280 KB Z80
disassembly), the MAME video-layer research, W28b research, R03 (after two lost subagent
attempts), **every review verdict** (W24a, W24b, W25a, W25b, W26, W27, W28a, W28b, W29), and
several parent-side fixes (`d99017a`, `c6c7de2`, `a8c9b0e`).

`sp-review` exists, is on the `max` tier, and appears essentially unused. Every review the
parent runs is a review that runs *serially inside the most expensive context in the system*.

Research is stuck on the parent for a concrete reason, and it is fixable:

> Web research = PARENT's job (web_search rate-limited today; direct fetch_content of known
> URLs works). — `CONTEXT.md`, standing facts

Two independent causes, both already documented elsewhere:

- the search provider is pinned to Exa with no fallback
  (`2026-08-30-agent-web-browser-toolkit.md` §1–2) → SearXNG fixes the rate limit;
- **`superagents.extensions` is `null`, so no subagent has `pi-web-access` at all** — not even
  `sp-research` (§6 of the same doc). Even with SearXNG running, research *cannot* move off
  the parent until that is set.

Research quality has already cost real time: R02 failed review once on wrong game attribution,
R03 lost two subagent attempts.

## 6. Vision: one place it would pay

The pixel-assertion approach is **better** than screenshots for regressions — deterministic,
cheap, runs in `make test`, no model in the loop. Do not replace it.

But the open `[to-verify]` list ends with:

> boat art taste (W31 human audit: silhouette, wake, island density, banner timing)

That is the one item blocked on a human, and it is WebGL — no DOM, so the accessibility-tree
route from `2026-08-30-agent-web-browser-toolkit.md` §4 does not apply. **This is the canvas
case where vision is the only channel.** A screenshot → model critique loop could pre-screen
W31's aesthetic judgments before the human sees them. Not a speed win on the build chain; a
way to stop W31 being a hard human gate.

## 7. Recommendations, ranked

1. **Restart the parent per work package.** `ledger/README.md` already specifies the recovery
   path — *"a new agent should be able to pick up by reading `GOAL.md` → `CONTEXT.md` →
   `LEDGER.md` (tail) → `PLAN.md`"*. That is ~10k tokens, plus the current task file. The
   mechanism was built as a "compaction breaker" and is not being used as one. This is free,
   needs no config change, and is the largest single win.
2. **Fix subagent web access** — SearXNG plus
   `superagents.extensions = ["npm:pi-web-access"]`. This unblocks moving research off the
   parent, which in turn is what makes item 3 possible.
3. **Overlap research with review.** Dispatch W33/W34 research while the parent reviews W30.
   2-wide, no code conflict, available today.
4. **Use `sp-review`** for the mechanical half of review (gates, diff-vs-brief spot checks) and
   keep the parent for the verdict. The parent's independent ×2 pin verification is genuinely
   valuable and should stay parent-side.
5. **Prefix caching**, once `2026-08-30-qwen38-agentic-settings.md` §13's measurement is done.
   It multiplies item 1 rather than replacing it.
6. **Do not widen fan-out past 3.** The graph is serial and the server saturates near 4.

Items 1 and 3 are available right now, cost nothing, and address the dominant term.

## 8. Automating the parent restart: a per-work-package orchestrator

§7's item 1 says "restart the parent per work package." Doing that by hand is not the point —
it can be an agent. Two ways, and the pieces already exist.

### Path A — a custom role agent that orchestrates one WP (integrated)

`pi-superagents` supports authoring bounded role agents (`docs/skills.md`, "Bounded Role Agent
Fields"), and `DEFAULT_SUBAGENT_MAX_DEPTH = 2` allows exactly two levels of delegation. So:

```
root driver (depth 0)  ->  sp-wp (depth 1)  ->  sp-implementer / sp-review (depth 2)
```

A new `~/.pi/agent/agents/sp-wp.md`:

```yaml
---
name: sp-wp
description: Runs one work package end to end from the ledger
kind: role
execution: headless
model: orchestrator
tools: bash, write
maxSubagentDepth: 1          # <- the whole trick; bundled roles ship 0
session-mode: standalone
extensions: npm:pi-web-access
---
Read ledger/GOAL.md, then ledger/PLAN.md, then the tail of ledger/LEDGER.md,
then ledger/CONTEXT.md. Take the next `todo` work package and run it end to end:
research -> build (delegate to sp-implementer) -> review (delegate to sp-review,
verdict yours) -> integration (commit + push + ledger).
Report back ONLY: WP id, verdict, commit SHAs, one-line test summary, concerns.
```

The root session then becomes a thin loop that dispatches `sp-wp` once per work package. Each
call returns a couple of hundred tokens instead of carrying a whole WP's reasoning, so the
root grows by ~200 tokens per WP rather than toward the 94,208-token compaction threshold.
Twenty work packages is ~4k of root growth — it never compacts.

Note `extensions` is a **per-agent frontmatter field**, which is a better answer to §5's web
problem than the global `superagents.extensions` setting: give web access to `sp-wp` and
`sp-research` specifically, not to `sp-implementer`.

### Path B — an external loop (zero plugin changes)

The same effect with no new agent file and no depth budget to reason about: run pi
non-interactively, once per work package, from a shell loop. Every iteration is a new process
with genuinely fresh context, and the ledger is already the state that survives between them.
The fresh process still has the `subagent` tool, so it can still delegate build and review.

Path B is the cheaper experiment. Path A is the better end state because progress stays
visible inside one session rather than in a terminal scrollback.

### The catch worth stating

The root/loop must resist the temptation to *read* what the WP produced. The moment it pulls
in diffs or reports, it accumulates again and we are back to an 18-hour parent. The bundled
agents already model the discipline — `sp-implementer`: *"Report back with ONLY status,
commits, a one-line test summary, and concerns — the detail lives in the report file."* Apply
the same rule one level up.

## 9. Tier shape, revised — three populations now exist

`2026-08-30-agent-web-browser-toolkit.md` §9 concluded "two tiers, not four", because there
were only two populations. A per-WP orchestrator creates a third, so the third tier now earns
its keep:

| Tier | Used by | Window | maxTokens | Thinking |
|---|---|---:|---:|---|
| `orchestrator` (new) | `sp-wp` | 110,592 | 32,768 | xhigh |
| `build` (today's `cheap`) | `sp-implementer` | **81,920** | 8,192 | medium |
| `light` (new) | `sp-recon`, `sp-research` | 49,152 | 8,192 | medium |

Reasoning: the orchestrator writes review verdicts, which is the judgment-heavy work, but it
starts fresh each WP so it rarely approaches its window — a large window costs nothing under
vLLM's on-demand allocation (settings doc §11). The implementer needs real room (W29 was 140
minutes of build) and medium effort per `models.nix`'s own finding that low effort costs more
in retries than it saves. Recon/research are short and read-only.

KV check against the measured 203,579-token pool: orchestrator fresh (~15k) + implementer
(≤80k) + two researchers (~20k each) ≈ 135k at fan-out 3. Fits.

### And the fix for the thinking-level problem

`docs/skills.md` states it outright:

> Normal dispatches **omit `model` and `tasks[].model`**, allowing these frontmatter tiers to
> resolve through `superagents.modelTiers`. Those tool fields are only for one-off model
> overrides explicitly requested by the user.

That is the documented answer to the observation in
`2026-08-30-agent-web-browser-toolkit.md` §8. Passing `model` in a dispatch sets
`hasModelOverride`, which makes `toThinkingLevel` discard the tier's thinking and fall back to
`defaultThinkingLevel: "high"` -> `xhigh`. **Dispatches should omit `model` entirely** and let
frontmatter resolve the tier. Put that in the orchestrator's brief as a rule.

## 10. Read the ledger stable-first, not `README.md`'s order

`ledger/README.md` specifies the recovery order:

> `GOAL.md` -> `CONTEXT.md` -> `LEDGER.md` (tail) -> `PLAN.md`

For a fresh-context-per-WP orchestrator with prefix caching on, that order is close to
worst-case. Prefix caching matches a *prefix*: everything after the first changed byte is a
miss. `CONTEXT.md` is **rewritten at every phase transition** (16,459 bytes today), so putting
it second invalidates `LEDGER.md` and `PLAN.md` behind it on every single WP.

Order the read by volatility instead:

| Order | File | Volatility |
|---|---|---|
| 1 | `GOAL.md` | frozen (human decision only) |
| 2 | `PLAN.md` | append/status edits, slow |
| 3 | `LEDGER.md` (tail) | append-only |
| 4 | `CONTEXT.md` | **rewritten every WP** |
| 5 | `tasks/<current>.md` | new each WP |

Same information, but every WP orchestrator then shares a byte-identical prefix through
GOAL + PLAN + most of LEDGER, and only pays for the volatile tail. Combined with identical
`sp-wp` frontmatter (same tools, same effort -> same system block), consecutive WP
orchestrators would hit cache on nearly their whole preamble.

This is the one place where the per-WP orchestrator pattern and prefix caching compound rather
than just coexist — and it is a two-line edit to `ledger/README.md`.

## 11. Prompts

### Where the original prompt fell short

The original was good — it produced 30 reviewed work packages in 18 hours. Three gaps, all
measurable in the result:

| Instruction | What happened |
|---|---|
| *"keep all steps and context in files"* | Files were written **and** everything stayed in the conversation. The ledger became *additional* context, not *replacement* context — 21 MB session, 10 compactions. |
| *"pick weaker models for subagents for tasks that don't need high thinking"* | Tiers were built correctly, but dispatches passed `model`, which silently discarded the tier's thinking and ran children at `xhigh`. |
| *"run completely autonomous"* | Read as "one session runs forever" rather than "any session can be killed and the next resumes from files". Nothing said when to **stop**. |

Nothing said the orchestrator should *not do the work itself*, so it wrote every review verdict
and much of the research inline.

### Can this be fixed by prompting mid-run?

**No.** Prefill cost is a function of what is already in the conversation. A steering message
adds to it. Only a restart (or a compaction, which costs 25–40 s and loses information) clears
it. The fix is structural: end the session at a work-package boundary and start a new one.

### Restart prompt (usable now — W33 build is uncommitted, ~400 insertions across 7 files)

```text
You are the orchestrator for spy-hunter-vibe, in the worktree
/var/lib/paseo/worktrees/25trkhou/mundane-horse on feat/spyhunter-parity.
This session runs EXACTLY ONE work package, then stops. You are disposable;
the ledger is the memory.

READ, IN THIS ORDER, AND NO MORE
1. ledger/GOAL.md          (whole - the charter)
2. ledger/PLAN.md          (whole - work packages + status)
3. ledger/LEDGER.md        (TAIL ONLY - `tail -60`. Never the whole file.)
4. ledger/CONTEXT.md       (whole - live state)
5. The task file for the current work package only.
Do not read task files for completed work packages. Do not read source you
are not about to judge. This order is deliberate: stable files first, the
file that changes every work package last.

FIRST, RECOVER STATE
Run `git status` and `git diff --stat`. There is uncommitted W33 work
(~400 insertions / 122 deletions across 7 files) from the run I stopped.
From the diff and ledger/tasks/W33-*.md decide whether it is complete,
partial, or should be discarded. Log that decision to LEDGER.md before
anything else.

THEN RUN ONE WORK PACKAGE: research -> build -> review -> integration.
- DELEGATE THE BUILD. subagent { agent: "sp-implementer", task: ... }.
  You do not write feature code.
- DELEGATE THE MECHANICAL REVIEW. subagent { agent: "sp-review", ... } with
  an explicit `Review scope:`. It runs the gates and the diff-vs-brief
  check; the verdict is yours.
- NEVER pass `model` or `tasks[].model` in a dispatch. Passing it silently
  discards the tier's thinking level and the child runs at xhigh. Let the
  agent frontmatter resolve the tier.
- Fan-out <= 2, and only for independent read-only research.
- Subagents report status + commit SHAs + one-line test summary + concerns;
  detail lives in their report file. You report to me the same way.

CONTEXT DISCIPLINE
The ledger replaces your memory, it does not supplement it. If you are about
to re-read something you already summarised into a file, read the file
instead. If you approach compaction, write CONTEXT.md and stop - a fresh
session is cheaper than a summary.

BEFORE YOU STOP
1. Update ledger/PLAN.md status, append to ledger/LEDGER.md, rewrite
   ledger/CONTEXT.md so the next session resumes from files alone.
2. Commit and push.
3. Report: WP id, verdict, commit SHAs, test summary, concerns, exact next
   action.
Then STOP. Do not start the next work package.
```

Run it once per work package. Two edits make it repeatable: drop the "FIRST, RECOVER STATE"
block after the first run, and amend `ledger/README.md`'s recovery order to
`GOAL -> PLAN -> LEDGER (tail) -> CONTEXT -> task file` (see §10).

### Improved version of the original project prompt, for next time

```text
Interview me to realise a project. Then break it into work packages, each
with a research phase, a build phase, and a separate review phase.

STATE LIVES IN FILES, NOT IN YOUR CONTEXT.
Create a ledger directory: GOAL.md (charter), PLAN.md (work packages +
status), LEDGER.md (append-only event log), CONTEXT.md (live state, rewritten
at each phase transition), tasks/NNN-slug.md (one per work package: brief,
findings, verdict, links). The test is: I can kill you at any work-package
boundary and a fresh agent resumes from these files alone with nothing lost.
Files are a REPLACEMENT for what you remember, not a copy of it.

ONE WORK PACKAGE PER SESSION.
Finish a work package, write the ledger, commit, report, and STOP. Do not
start the next one. I (or a loop) will start a fresh session. Never let a
session reach compaction - if you get close, checkpoint to CONTEXT.md and
stop instead.

YOU ORCHESTRATE; YOU DO NOT IMPLEMENT.
Delegate builds and the mechanical half of review to subagents. Keep the
verdict, the plan, and the integration for yourself. Every subagent returns
status + commits + a one-line test summary + concerns; the detail goes to a
report file. You report to me the same way.

MODEL TIERS.
Give each subagent role a tier: strong+high-thinking for judgement (review
verdicts, design), weaker+medium for mechanical work (digests, test runs,
diff extraction). Set the tier in the AGENT DEFINITION and never pass an
explicit model in a dispatch - an explicit model can silently override the
tier's thinking level. Match effort to task; keep briefs compact.

READ ORDER.
Read stable files before volatile ones - charter, then plan, then the tail
of the log, then live state, then the current task file. Never re-read the
whole log or completed task files.

CONCURRENCY.
All agents share one local inference server. Fan out at most 2-3, and only
for genuinely independent work - a wider wave queues rather than going
faster. Work that touches the same files or the same test baselines is
serial; do not try to parallelise it.

VERIFICATION.
Every build is test-driven. Every review ends in a written verdict (pass /
pass-with-nits / fail + reasons) in the task file; a fail re-enters the
chain. Verify visual work by asserting on rendered output, not by eyeballing.

We begin work after the interview.
```

The substantive additions over the original are the kill-test framing of "files", the
one-work-package-per-session stop rule, "you orchestrate, you do not implement", the
never-pass-an-explicit-model rule, and the stable-before-volatile read order.

## 12. Automating the loop

`pi` has a one-shot non-interactive mode (`docs/quickstart.md:147-155`):

```bash
pi -p "Summarize this codebase"
pi --mode json "..."     # structured event stream, incl. compaction_start/compaction_end
```

**Each `pi -p` invocation is a new process with fresh context.** That is the whole mechanism —
a shell loop around it gives one work package per session with a hard guarantee, no plugin
changes, and no reliance on the model deciding to stop.

### Why a shell loop beats an in-pi orchestrator here

§8's Path A (an `sp-wp` role agent with `maxSubagentDepth: 1`) works, but the root session
still accumulates, still has to *decide* to loop, and can drift. A shell loop's freshness is
structural, its failure handling is explicit rather than model-driven, and it needs nothing
installed. Keep Path A in reserve for when progress needs to be visible inside one pi UI.

### The prompt file

Take §11's restart prompt and make the recovery block generic, so every iteration is
identical and a crash mid-work-package is handled the same way as a clean start:

```text
FIRST, RECOVER STATE
Run `git status` and `git diff --stat`. If there is uncommitted work, decide
from the diff and the current task file whether it is complete, partial, or
should be discarded, and log that decision to LEDGER.md before anything else.
```

Save as `ledger/ORCHESTRATOR.md`. Everything else in §11's prompt is already loop-safe.

### The loop

```bash
#!/usr/bin/env bash
# run-ledger.sh — one work package per pi session, until the plan is done.
set -uo pipefail
cd /var/lib/paseo/worktrees/25trkhou/mundane-horse || exit 1

MAX_ITERS=${MAX_ITERS:-40}
LOG=ledger/run.log
stalls=0

for ((i = 1; i <= MAX_ITERS; i++)); do
  [[ -f ledger/STOP ]] && { echo "stop sentinel present"; break; }

  before=$(git rev-parse HEAD)
  echo "=== iter $i $(date -Is) HEAD=$before ===" | tee -a "$LOG"

  pi -p "$(cat ledger/ORCHESTRATOR.md)" 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}

  after=$(git rev-parse HEAD)
  if [[ "$before" == "$after" ]]; then
    stalls=$((stalls + 1))
    echo "no commit this iteration (rc=$rc), stall $stalls/2" | tee -a "$LOG"
    (( stalls >= 2 )) && { echo "two stalls, stopping for a human"; break; }
    sleep 30
  else
    stalls=0
  fi
done
```

Three guards, all deliberate:

- **`MAX_ITERS`** — a backstop so a confused agent cannot burn the GPU overnight.
- **HEAD-advance check** — the honest progress signal. `pi`'s exit code says the process
  exited, not that a work package landed. Two consecutive iterations with no commit stops the
  loop for a human. This is what catches "the agent is stuck re-reading the plan."
- **`ledger/STOP`** — the agent writes this when `PLAN.md` has no remaining work. Add one line
  to the prompt: *"If every work package in PLAN.md is `done`, write `ledger/STOP` with a
  one-line reason and stop."*

Run it under `tmux`/`nohup`, or as a user systemd unit if you want it to survive a
disconnect — the container already runs systemd.

### What to watch

`ledger/run.log` gives per-iteration wall clock. The two numbers that matter:

- **Iterations that stall** — the agent could not resume from files alone. That is a ledger
  defect, not a model problem: fix `CONTEXT.md` to say where work stands.
- **Compaction inside a single iteration.** There should be none. If an iteration compacts,
  that work package is too big for one session — split it, which is exactly the "compaction
  breaker rule" already in `GOAL.md`. `pi --mode json` emits `compaction_start` /
  `compaction_end`, so the loop can grep for it and warn.

That second check is the real payoff: it turns "the parent got huge" from something only
findable by grepping a 21 MB session file into a per-iteration alarm.
