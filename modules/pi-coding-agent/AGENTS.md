# Subagent dispatch

Loaded as pi's global context file (`~/.pi/agent/AGENTS.md`), so it survives
compaction — unlike anything said once at the top of a session. Children
inherit it too, so keep it short.

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
thinking budget caps the reasoning half. So a long deliverable at `xhigh` can
spend its whole allowance thinking and return `stopReason: "length"` with
nothing written. Reviewers and anything that must emit a long verdict: `medium`.
Reserve `high`/`xhigh` for short answers to hard questions.

## Concurrency

The server admits 2 sequences at once. A third dispatch queues — it costs
latency, not memory — so fan out 2 wide and let the rest wait rather than
splitting the work into more, smaller children.

Workers run 64–68k input tokens per turn against a window that compacts at
~82k, so a worker has room for one substantial task, not three. Split by task,
not to save context.
