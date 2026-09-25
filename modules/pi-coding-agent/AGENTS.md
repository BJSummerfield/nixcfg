# Subagent dispatch

pi's global context file (`~/.pi/agent/AGENTS.md`): survives compaction, read by
the dispatching session only. Children inherit the repository's `AGENTS.md` and
the environment contract, never this file — policy a child must follow goes in
the repository.

## Model and thinking

Every role's model, output budget and thinking level are set in nix
(`agentOverrides`). A dispatch never needs `model:`; single-agent dispatch has
no such field, and omitting it is correct. Chain and parallel steps do take a
`model` field: leave it out. Setting it makes the call site the origin and the
role's nix pin is silently ignored.

Reasoning and answer share one output budget, so a long deliverable at a high
level can spend it all thinking and return `stopReason: "length"` with nothing
written. Brief a reviewer verdict-first (verdict, findings with file:line, then
evidence) so truncation loses only tail evidence.

## Context limits

`clampMaxTokensToContext` caps a turn at `contextWindow - context - 4096`, so
the output budget shrinks as the transcript grows: **98,304 minus whatever the
prompt already costs**, floored at 1 token. That (not `maxModelLen`) is what
produces `length` deaths, and it is why a long session's replies get shorter
before they stop entirely. A session that reaches the floor cannot self-recover
— auto-compaction's summary call overflows identically. Resume from a fork.

- Fork only a child that needs your working context; dispatch self-contained
  briefs fresh. A fork of a large parent burns its budget in the inherited
  compaction window before its first useful turn, and the engine re-prefills
  the whole inherited context: nothing is cached across a fork.
- Long text goes to disk, never inline in a task string (a few KB inline
  arrives truncated). First stage writes it under `/var/tmp`; later stages read.

## Concurrency

The engine admits a fixed number of sequences; the number is deliberately not
written here — do not infer one. Over the cap a dispatch **queues** (no failure,
no eviction, latency only).

Split by task: two children for two separable tasks, one for one. Never chop a
task to fill a free slot or fold two into one child to dodge the queue. A worker
has room for one substantial task; turn sizes and compaction threshold are
likewise deliberately absent. Size by the work and let it compact.

## Async dispatch

Nothing pushes a running child's state into your context. After an async
dispatch, `bg_wait` or poll `subagent {action: "status"}` before concluding
anything; silence proves nothing.

- `needs attention (no observed activity)` with **0 turns, 0 tokens, 0 tools**
  means queued or compacting, not dead. If `status` says `running`, leave it.
  Steer only a child with turns and tools on the record that has visibly
  stalled.
- A steer is a turn. "Respond with a short status" is answered and the run
  **ends** half done. Every steer must say to continue the task afterwards.
- Completion notices are best-effort. `bg_wait` is not; use it for anything you
  cannot afford to redo.

## Dispatch API

Tool access (frontmatter `tools:` is the source of truth):

| Agent | Tools |
|---|---|
| worker, delegate, scout, oracle | `bash` |
| reviewer | `read/grep/find/ls` + `watchdog_diff` |
| researcher | `read/write` + web tools |

Give shell steps to a `worker` rather than running them yourself. A child
lacking a tool escalates mid-run via `subagent_supervisor`
(list/send/ask/reply/pending/status — plain `subagent` has no `pending`).

`workflowScript` is plugin API and moves between releases; the plugin's guide
is the reference, not this file. What holds regardless of version:

- Run `subagent {action: "validate", workflowScript}` before any long launch.
- A declared `output` under `/tmp` is deleted on completion; the session's
  `subagent-artifacts/` copies persist. A child's `write` may be rerouted to
  that managed path even when given an absolute one: check the reported path
  and copy to a stable location before a dependent stage.
- Run status `failed` ≠ work failed: a child can finish and die emitting its
  report. Read the on-disk result before re-dispatching.

## Images

The engine admits **@imageBudget@ images per prompt**, counted across the whole
conversation (history is resent every turn). Exceeding it is terminal: every
later request fails with

```
400 BadRequestError: At most @imageBudget@ image(s) may be provided in one prompt.
```

including the compaction that would have evicted them.

**Do not read images in this session.** Dispatch a child to look and report in
prose; a child that overruns kills only its own run. `At most N image(s)` means
the result was lost, not that the work is impossible: re-dispatch with fewer
images per child (one each if unsure), and recover its disk work rather than
reviving it. Brief the child:

- Re-reading an image costs a fresh slot: take notes while reading, never look
  twice; record an illegible detail as a caveat with the path.
- A re-review after a fix round goes to a **fresh** child, not a resume (a
  resume carries the earlier images into the new budget).
- A child that only captures or verifies works from DOM/text and does not read
  screenshots back.

## Durable knowledge

No local scratch file; this file is generated by nix. Something true of the
repository you are in goes into that repository's `AGENTS.md`, in the same
change as the work that taught it. Something true of pi or this container goes
to the nix config as a PR.
