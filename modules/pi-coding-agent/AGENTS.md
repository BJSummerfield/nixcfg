# Subagent dispatch

Loaded as pi's global context file (`~/.pi/agent/AGENTS.md`), so it survives
compaction — unlike anything said once at the top of a session. It reaches the
dispatching session only: `inheritGlobalContext` defaults to false and none of
the bundled agents set it, so a child never sees this file. Policy a child must
follow goes in the repository's own `AGENTS.md`, which every bundled agent does
inherit (`inheritProjectContext: true`).

## Model

One model is served at a time. Every id in the registry is that same running
instance; naming a *different* model tears the loaded one down and stalls for
minutes. Do not do it mid-session.

A child inherits the parent's model when the dispatch omits `model:`. That is
the right default — the full window. Pass `model:` only to size a child
deliberately, and get the exact `provider/id` from `{action: "models"}` first;
bare ids resolve only when unique, and agent names are not model ids.

## Thinking

Thinking is a suffix on the **model string**, so the whole `provider/id:level`
goes in the `model:` field — e.g. `model: "redtruck/Qwen3.8-27B-NVFP4:medium"`.
The level cannot travel on its own: a bare suffix (`model: ":medium"`) is
rejected at launch with `Unknown subagent model`. Get the exact `provider/id`
from `{action: "models"}` and append the level to it. The suffix overrides the
agent's frontmatter default. `thinking` is not a dispatch field at all and is
**ignored** there (it only applies to `action: "watchdog.configure"`).

Reasoning and the answer share one `max_tokens` on this server, and no separate
thinking budget caps the reasoning half. So a long deliverable at a high level
can spend its whole allowance thinking and return `stopReason: "length"` with
nothing written.

The frontmatter defaults run hot into that: `worker`, `reviewer` and `oracle`
all declare `thinking: high`, and this model maps `high` to the server's
`xhigh`. An unqualified `worker` dispatch is therefore already at maximum
effort. Pass the suffix rather than relying on the default:

- **Workers: `provider/id:medium`.** Code deliverables are long; the `high`
  default risks an empty `length` stop mid-file.
- **Researchers: `provider/id:medium`.** Reports are long.
- **Reviewers: `provider/id:high`** when the verdict is the deliverable and
  depth pays.
  Keep it verdict-first and bounded (verdict line, then findings with
  file:line, then evidence) so a truncation loses tail evidence, never the
  verdict.
- **Orchestrator:** set on the session, not per dispatch. Children inherit the
  model, not the level.

Reserve `xhigh`/`max` for one-off short answers to hard questions.

## Context limits

`clampMaxTokensToContext` caps the largest total a turn may emit at
`contextWindow - 4096` — 94,208 tokens here — and that, not the provider's
separate `maxModelLen`, is the mechanism behind those `length` deaths. A session
that reaches it cannot recover on its own: auto-compaction's own summary call
overflows identically. Resume from a fork.

Fork only a child that genuinely needs your working context. When the brief is
self-contained, dispatch fresh — a fork of a large parent spends its budget in
the inherited compaction window before its first useful turn.

Long text goes to disk, never interpolated into a task string: a few kilobytes
of spec passed inline arrives truncated mid-sentence. Have the first stage write
it verbatim under `/var/tmp` and let later stages read it from there.

## Concurrency

The engine admits a fixed number of sequences at once, and that number is
deliberately not written here. A dispatch over the cap **queues** — it does not
fail, and it evicts nothing — so overshooting costs latency and nothing else. A
number in this prose would be a standing copy of `maxNumSeqs` with no mechanism
keeping it honest, and the only decision it could inform is one that should not
be made on it anyway.

Split by task. Two children because there are two separable tasks, one child
because there is one — never a task chopped smaller to fill a free slot, and
never two tasks folded into one child to dodge the queue.

A worker has room for one substantial task, not three. The turn sizes and the
compaction threshold that would say so numerically are deliberately absent for
the same reason as the sequence cap: the window derives from `maxModelLen` and
`headroom`, the threshold subtracts pi's own `reserveTokens` default, and prose
here tracks none of them. Size a child by the work, and let it compact.

## Async dispatch

Between launch and completion, nothing pushes a child's running state into your
context — the TUI knows it is alive, you do not. After dispatching async, either
`bg_wait` or poll `subagent {action: "status"}` before concluding anything.
Silence is not evidence that a child is still working, and it is not evidence
that the dispatch never happened.

Idleness is not death. A child flagged `needs attention (no observed activity)`
with **0 turns, 0 tokens and 0 tools** has usually not started: it is queued
behind the sequence cap, or it is compacting. Both are indistinguishable from
dead out here. Read `status` before acting on the flag — if it says `running`,
leave it alone; the run typically finishes minutes later. Steering is for a
child with turns and tools already on the record that has visibly stalled.

And a steer is a turn. A steer phrased as "respond with a short status" is
answered and the run **ends** — the child treats the checkpoint as the task and
completes with the real work half done. Any steer must say to continue the task
after responding.

Completion notices are best-effort. Delivery is gated on an id that is fresh per
pi process, and the replay record expires after about ten minutes — so a child
whose parent process is replaced mid-run finishes into nowhere: the result is
written and never read. `bg_wait` pulls it and survives that; the notification
does not. Use it for anything you cannot afford to redo.

## Dispatch API

Shell access is per agent and the agent's frontmatter `tools:` is the source of
truth: `worker`, `delegate`, `scout` and `oracle` have `bash`; `reviewer` has
`read/grep/find/ls`; `researcher` has `read/write` plus the web tools. Routing a
shell step through yourself by reflex serializes work a `worker` could have
done. A child that genuinely lacks a tool escalates mid-run through
`subagent_supervisor` (list/send/ask/reply/pending/status — the plain `subagent`
tool has no `pending`), and its disk state survives the exchange.

A task classifier runs **before launch** and kills a read-only agent whose task
text sounds like implementation — including negated and meta uses ("do not
rewrite the docs"). Keep reviewer, oracle and researcher briefs in pure
review/analysis vocabulary. The child never ran: reword and re-dispatch.

The rest fail at launch or, worse, silently:

- `runs.all()` takes spec objects `{key, agent, task, model}`, not the handles
  `runs.run()` returns — passing handles kills the workflow.
- `resume` and `agent` are mutually exclusive in `runs.run`; a resumed run
  inherits the original's agent and model.
- Results carry `.ok` (plus `.output`/`.outputReference`), not
  `.status`/`.summary`. A guard on `.status` tests an empty string and skips
  every later stage.
- Top-level `workflowScript` requests reject `model`, `timeoutMs`,
  `globalConcurrencyLimit` and `action` — per-child model goes in the spec — and
  a top-level `lane.key` must equal a child key or nothing launches at all. Lane
  metadata is display-only; omit it.
- A workflow's declared `output` under `/tmp` is deleted when the workflow
  completes, while the session's `subagent-artifacts/` copies persist. A child's
  `write` may be rerouted to that managed artifact path even when the task gives
  an absolute one, so check the reported path and copy to a stable location
  before launching a dependent stage.
- Run status `failed` ≠ work failed: a child can finish everything and die
  emitting its final report. Read the on-disk result before re-dispatching.
- Workflow scripts are JavaScript: no implicit adjacent-string concatenation,
  and a literal backtick inside a template literal (a markdown code span in task
  text) fails at parse, so nothing launches. Build task text by joining quoted
  lines, and run `subagent {action: "validate", workflowScript}` before any long
  async launch.

## Images

The engine admits **@imageBudget@ images per prompt**, and that budget is
counted across the whole conversation, not per message — pi resends the
history every turn, so it is cumulative for the session. Exceeding it is
terminal for that context: the request fails with

```
400 BadRequestError: At most @imageBudget@ image(s) may be provided in one prompt.
```

and so does every request after it, including the next thing the user types
and the compaction that would have evicted the images. Under the budget,
compaction does drop them and hand it back; over the budget, nothing does.

**Do not read images in this session.** Dispatch a child to look at one and
report back in prose. The image lives in the child's context and only text
returns, so your budget is untouched, and a child that overruns kills its own
run rather than yours.

That makes the overrun a recoverable failure. A child that dies with `At most
N image(s)` has told you its result did not arrive, not that the work is
impossible: re-dispatch with fewer images per child — one each if unsure —
and the images are gone with the child's context either way.

Brief the child accordingly. Re-reading the same image costs a fresh slot, so it
writes its notes as it reads and never looks twice; an illegible detail is
recorded as a caveat with the path, not re-opened. A vision re-review after a
fix round goes to a **fresh** child rather than a resume, which would carry the
earlier run's images into the new budget. A child that only captures or verifies
should work from DOM or text evidence and not read screenshots back at all. And
one that died on the cap has usually left its disk work intact: recover from
disk instead of reviving it.

## Durable knowledge

There is no local scratch file. This file is generated by nix and replaced on
every rebuild, and the writable `LESSONS.md` that used to sit beside it is gone:
its only declared exits were promotion into a repository's `AGENTS.md` or into
the nix config, and neither is reachable from a session working in some other
repository — so it could only grow, or quietly lose what it held.

Promote directly instead. Something true of the repository you are in goes into
that repository's own `AGENTS.md`, in the same change as the work that taught it
to you. Something true of pi or of this container is universal and goes to the
nix config as a PR the user reviews. Both are versioned and both are read by
someone; a private file was neither.
