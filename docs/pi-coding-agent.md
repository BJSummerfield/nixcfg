# pi coding agent: design notes

Status: accurate as of 2026-09-05, describes `modules/pi-coding-agent/settings.nix`.

`modules/pi-coding-agent/settings.nix` builds the data that seeds pi's
`settings.json` and `models.json`. The file itself carries the short,
adjacent facts; this doc carries the three design essays that were too long
to sit next to a single line of config.

## Vision gating

Option: `inputsOf`.

What `inputsOf` gates is narrower than it looks, and the difference is the
whole reason it is easy to conclude vision works when it half does.

`model.input` is referenced exactly once in `openai-completions.js`, at the
tool-result branch (`:1021`, `if (hasImages && model.input.includes("image"))`).
The user-message branch has no check at all — an attached image becomes an
`image_url` part unconditionally. So:

- attach an image yourself -> works with `input` absent entirely
- a tool returns an image -> silently dropped unless `"image"` is listed,
  and the model receives the literal text `"(see attached image)"` instead

Subagents live on the second path: a child reads a screenshot with a tool,
so without this it gets that placeholder string and reports it cannot see
anything — while the parent session, where a human attaches the file, looks
perfectly fine. That asymmetry is the only signal that this list is stale,
since provider-composer defaults it to `[ "text" ]` (`:70`).

`inputsOf` derives `input` from the model catalog's `vision` block so the
prompt (this list) and the enforcement (the engine's actual vision support)
cannot drift apart.

## Subagent model routing

Option: `subagents.maxThinking`.

The `subagents` block sets subagent model routing, and nothing else. Which
role does what, and how hard it thinks, is a per-dispatch decision the
prompting agent makes: `subagent { agent, model, thinking, task }` beats
every setting here bar the ceiling. So nix sets a guard rail and nothing
else — no default to argue with, no policy.

No `defaultModel`. It reads like a floor and is not one: pi-subagents
attaches it as the agent's own `model` (`modelSource.type`
`"subagents.defaultModel"`), and `resolveEffectiveSubagentModel` takes
`explicitModel ?? agentModel` — so it wins on every dispatch that omits
`model`, for all six bundled agents, none of which pin one. Setting it is
therefore a standing override of the prompting agent's judgement in exactly
one direction, and the orchestrator can only escape it by passing `model:`
on every single call.

Unset, pi-subagents falls through to inheriting the parent session's
in-memory model (provider/id, not the global settings default — that
indirection is deliberate upstream, so another open pi session cannot
contaminate this one's children). That is the wanted default: children get
the same instance and the same full window as the parent, and the dispatch
may still size *down* per call with a `:suffix`.

`maxThinking` is a hard ceiling — a request above it fails before the child
starts, covering frontmatter, per-run overrides and nested launches alike.
No `defaultThinking` to go with it: it only fills agents that declare no
level, and of the bundled six only `delegate` qualifies. `models.nix` maps
pi's levels onto what the chat template accepts, and folds low to medium
there.

## Web search provider list

Option: `webSearch.provider`.

The list is every provider that needs no API key, queried in parallel and
merged (deduplicated by result URL). This was pinned to exa alone, whose
keyless endpoint is the standing "web_search rate-limited" failure — and
research is the one thing this stack does constantly.

It is a list, not one of the two keywords, because neither does what it
sounds like:

- `"auto"` walks a fixed priority order and returns the *first* available
  provider. `isExaAvailable()` is hardcoded `true`, so with no keys set
  auto resolves to exa every time — unpinning alone changes nothing.
- `"all"` fans out, but over its own list, which explicitly excludes
  duckduckgo, anysearch and parallel-mcp — so it collapses back to exa too.

Only an explicit list reaches the other keyless providers.

Failures are per-provider: a provider that errors becomes a "Provider
errors" note appended to the answer, and only an all-provider failure
throws. So a throttled exa thins the result set instead of blocking the
search — which is the whole point of listing more than one.

Buying a key later is appending that provider's name to the list in
`settings.nix`, plus its `<name>ApiKey` in that same file.

Note anysearch and parallel-mcp are third-party endpoints that will see
every query. Drop them to `["exa" "duckduckgo"]` if that is not wanted; the
two well-known ones already give the redundancy.

See [`modules/pi-coding-agent/settings.nix`](../modules/pi-coding-agent/settings.nix)
for the actual config these notes explain.
