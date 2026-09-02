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

Thinking is a suffix on the model string — `provider/id:medium`. It overrides
the agent's frontmatter default. The `thinking` field is **ignored** on
dispatch (it only applies to `action: "watchdog.configure"`).

Reasoning and the answer share one `max_tokens` on this server, and no separate
thinking budget caps the reasoning half. So a long deliverable at a high level
can spend its whole allowance thinking and return `stopReason: "length"` with
nothing written.

The frontmatter defaults run hot into that: `worker`, `reviewer` and `oracle`
all declare `thinking: high`, and this model maps `high` to the server's
`xhigh`. An unqualified `worker` dispatch is therefore already at maximum
effort. Pass the suffix rather than relying on the default:

- **Workers: `:medium`.** Code deliverables are long; the `high` default risks
  an empty `length` stop mid-file.
- **Researchers: `:medium`.** Reports are long.
- **Reviewers: `:high`** when the verdict is the deliverable and depth pays.
  Keep it verdict-first and bounded (verdict line, then findings with
  file:line, then evidence) so a truncation loses tail evidence, never the
  verdict.
- **Orchestrator:** set on the session, not per dispatch. Children inherit the
  model, not the level.

Reserve `xhigh`/`max` for one-off short answers to hard questions.

## Concurrency

The server admits 3 sequences at once (`maxNumSeqs`). A fourth dispatch queues
— it costs latency, not memory — so fan out 3 wide and let the rest wait rather
than splitting the work into more, smaller children.

Workers run 64–68k input tokens per turn against a window that compacts at
~82k, so a worker has room for one substantial task, not three. Split by task,
not to save context.

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
