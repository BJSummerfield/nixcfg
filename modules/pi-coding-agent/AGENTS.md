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

Workers run 64–68k input tokens per turn against a window that compacts at
~82k, so a worker has room for one substantial task, not three.

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

## Lessons

`~/.pi/agent/LESSONS.md` is writable and persists across sessions. This file is
not — it is generated by nix and replaced on every rebuild, so nothing you learn
can be kept here. Read LESSONS.md when you pick up a task; append to it when you
finish one.

Append only what a later session would **act on differently**: a specific,
falsifiable claim and the thing it applies to. Not a summary of what you did —
that is for the human, and the transcript already has it.

It is an **inbox with a hard cap (~100 lines)**, not an append-only log, and it
has exactly two exits: promotion or deletion. Promotion means moving the lesson
into version control — the repository's own `AGENTS.md`, or the nix config that
generates this file and `settings.json` — as a change the user can review.
Deletion is the other half and is used more often. A file that only grows
displaces the context it was meant to save, so when it is at the cap, promoting
or deleting is the price of appending, not a chore to schedule later.
