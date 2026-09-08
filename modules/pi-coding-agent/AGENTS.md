# Subagent dispatch

pi's global context file (`~/.pi/agent/AGENTS.md`): survives compaction, read by
the dispatching session only. Children inherit only the repository's `AGENTS.md`
(`inheritGlobalContext` is false) — policy a child must follow goes there.

## Model and thinking

One model is served at a time; every registry id is that same instance. Naming a
*different* model evicts it and stalls for minutes. Never do it mid-session.

Omitting `model:` inherits the parent's model with the full window. To set a
thinking level, pass the full string from `{action: "models"}`:

```
model: "redtruck/Qwen3.8-27B-NVFP4:medium"
```

A bare `model: ":medium"` fails with `Unknown subagent model`; agent names are
not model ids; `thinking` is **not** a dispatch field and is ignored. The suffix
overrides the frontmatter default.

Reasoning and answer share one `max_tokens`, so a long deliverable at a high
level can spend it all thinking and return `stopReason: "length"` with nothing
written. `worker`, `reviewer` and `oracle` default to `thinking: high` (= the
server's `xhigh`), so always pass the suffix:

| Role | Level | Note |
|---|---|---|
| worker | `:medium` | code deliverables are long |
| researcher | `:medium` | reports are long |
| reviewer | `:high` | brief it verdict-first (verdict, findings with file:line, then evidence) so truncation loses only tail evidence |
| orchestrator | on the session | children inherit the model, not the level |

Reserve `xhigh`/`max` for one-off short answers.

## Context limits

`clampMaxTokensToContext` caps a turn at `contextWindow - 4096` = **94,208
tokens**; that (not `maxModelLen`) is what produces `length` deaths. A session
that reaches it cannot self-recover — auto-compaction's summary call overflows
identically. Resume from a fork.

- Fork only a child that needs your working context; dispatch self-contained
  briefs fresh. A fork of a large parent burns its budget in the inherited
  compaction window before its first useful turn.
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
- Completion notices are best-effort: gated on an id fresh per pi process, and
  the replay record expires after ~10 minutes, so a child whose parent process
  was replaced finishes into nowhere. `bg_wait` survives that; use it for
  anything you cannot afford to redo.

## Dispatch API

Tool access (frontmatter `tools:` is the source of truth):

| Agent | Tools |
|---|---|
| worker, delegate, scout, oracle | `bash` |
| reviewer | `read/grep/find/ls` |
| researcher | `read/write` + web tools |

Give shell steps to a `worker` rather than running them yourself. A child
lacking a tool escalates mid-run via `subagent_supervisor`
(list/send/ask/reply/pending/status — plain `subagent` has no `pending`).

A task classifier runs **before launch** and kills a read-only agent whose task
text sounds like implementation — including negated and meta uses ("do not
rewrite the docs"). Keep reviewer, oracle and researcher briefs in pure
review/analysis vocabulary; the child never ran, so reword and re-dispatch.

`workflowScript` traps (fail at launch or silently):

- `runs.all()` takes specs `{key, agent, task, model}`, not the handles
  `runs.run()` returns.
- `resume` and `agent` are mutually exclusive in `runs.run`; a resumed run
  keeps the original's agent and model.
- Results carry `.ok` (+ `.output`/`.outputReference`), not
  `.status`/`.summary`; a guard on `.status` skips every later stage.
- Top-level requests reject `model`, `timeoutMs`, `globalConcurrencyLimit`,
  `action` (per-child model goes in the spec). A top-level `lane.key` must equal
  a child key or nothing launches; lane metadata is display-only — omit it.
- A declared `output` under `/tmp` is deleted on completion; the session's
  `subagent-artifacts/` copies persist. A child's `write` may be rerouted to
  that managed path even when given an absolute one: check the reported path
  and copy to a stable location before a dependent stage.
- Run status `failed` ≠ work failed: a child can finish and die emitting its
  report. Read the on-disk result before re-dispatching.
- Scripts are JavaScript: no adjacent-string concatenation; a literal backtick
  inside a template literal fails at parse. Join quoted lines, and run
  `subagent {action: "validate", workflowScript}` before any long launch.

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
