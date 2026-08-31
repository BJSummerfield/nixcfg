# Agent Web + Browser Toolkit — Findings

**Date:** 2026-08-30
**Scope:** `modules/devbox/{plugins,container}.nix`, `modules/pi-coding-agent/settings.nix`,
and a possible new SearXNG service.
**Status:** research; nothing changed. Companion to
`2026-08-30-ninfer-spike.md` and `2026-08-30-qwen38-agentic-settings.md`.

## 1. Where the rate limit actually comes from

`settings.nix:150-158`:

```nix
webSearch = {
  workflow = "auto-summary";
  provider = "exa";
  curatorTimeoutSeconds = 20;
  summaryModel = qualified llm.default;
};
```

The summary pass already runs on our own model, so there is no external LLM quota in the
loop. The only metered dependency is **Exa**, and `provider = "exa"` pins it explicitly —
which also disables pi-web-access's fallback chain. One provider, no fallback, someone
else's quota.

## 2. SearXNG is directly supported, and it is tried first

`pi-web-access@0.26.0` ships `searxng.ts`. From its README:

> Search tries configured SearXNG first for local/private search.

So in `auto` mode SearXNG is the *head* of the fallback chain, not an alternative to it.

Configuration is either the `SEARXNG_BASE_URL` environment variable or `searxngBaseUrl` in
`~/.pi/web-search.json` (`searxng.ts:67-71`).

### The gotcha that will cost an afternoon

`searxng.ts:200-204` builds the query as:

```js
const url = new URL(`${baseUrl}/search`);
url.searchParams.set("q", searchQuery);
url.searchParams.set("format", "json");
```

**SearXNG serves HTML only by default.** `search.formats` must explicitly include `json` or
every request 403s. In NixOS terms:

```nix
services.searx = {
  enable = true;
  package = pkgs.searxng;          # 0-unstable-2026-08-22 in our pin
  redisCreateLocally = true;
  settings = {
    server.secret_key = "@SEARXNG_SECRET@";   # via environmentFile
    server.bind_address = "0.0.0.0";
    server.port = 8888;
    search.formats = [ "html" "json" ];       # <- the one that matters
  };
  environmentFile = config.sops.secrets.searxng-secret.path;
};
```

Then either drop `provider` from the `webSearch` block (auto: SearXNG first, then the rest of
the chain if it is down) or set `provider = "searxng"` for strictness. **Auto is the better
choice** — it gets SearXNG-first *and* graceful degradation.

### Honest caveat on "no rate limits"

SearXNG is keyless and unmetered *by us*, but it is a metasearch proxy: it forwards to
Google, Bing, DuckDuckGo, Brave and friends, and those can throttle or captcha **it**.
Self-hosting moves the rate limit from a vendor's account quota to per-engine scraping
limits. Mitigate by enabling many engines so load spreads, and keep the auto fallback chain
so a throttled SearXNG degrades instead of failing.

### Where to run it

It needs network egress and is reachable over the veth. Either the existing `local-llm`
container or a small dedicated one. Do **not** put it in `devbox`/`workbox` — those are
per-agent and we would end up with two instances doing duplicate upstream scraping.

## 3. pi-web-access has no browser at all

Its complete dependency set (`package.json:46-56`):

```
@mozilla/readability, defuddle, linkedom, p-limit, promise.try,
turndown, typebox, unpdf, undici
```

`undici` fetches, `linkedom` parses, `readability`/`defuddle` extract the article, `turndown`
converts to markdown. **There is no Playwright, no Puppeteer, no headless Chrome, and no
JavaScript execution.** A modern SPA arrives as an empty shell.

So a browser is genuinely additive, not a duplicate of what we have. Available in our pin:
`chromium` 151.0.7922.173, `playwright-driver` 1.61.1.

## 4. Text first, screenshots second — and why

The question "do we need vision for web dev agent coding" deserves a real answer: **mostly
no, and the vision-shaped part is narrower than it looks.**

For reviewing our own running app, the highest-value browser output is *text*:

- DOM snapshot / outerHTML of a selector
- accessibility tree (roles, names, states — what a screen reader sees)
- console errors and warnings
- failed network requests
- computed styles for specific selectors

An LLM reasons far better over `button.submit { width: 0px; overflow: hidden }` than over a
picture where it has to *infer* that the button is invisible. Text is exact, diffable,
greppable, and citable in a patch. A screenshot is a lossy re-encoding of information the DOM
already has precisely.

Screenshots earn their place in three cases, and they are real:

1. **Purely visual defects** — overlap, z-index, contrast, spacing that is valid CSS and
   still wrong. No DOM assertion catches "this looks bad."
2. **Visual regression** — capture, compare against a baseline, show the diff.
3. **Canvas / WebGL, where there is no DOM.** This is the game case from the earlier
   conversation. The DOM tells you literally nothing about a rendered frame, so vision is not
   a nicety there, it is the only channel.

Cost is comparable either way: a 1080p screenshot downscales to the 1 MP cap and lands at
**~1,024 tokens** (`2026-08-30-qwen38-agentic-settings.md` §9); an accessibility-tree dump of
a real page runs roughly 500-3,000 tokens. The difference is not price, it is precision — and
at 1 MP, fine detail (small labels, 1px borders, sub-pixel alignment) is degraded, so
screenshots are good for gross layout and bad for pixel work.

**Conclusion: build the browser tool text-first and add `--screenshot` as a second mode.**
One Playwright script, two outputs. Vision is the complement.

## 5. Integration shape — no plugin required

pi already accepts images from two paths, so nothing needs to be written as an extension:

- `read` on a PNG runs through `processImage` (png/jpeg/webp, auto-resized)
- tool results may carry image blocks, normalized by `dist/utils/tool-result-images.js`

So the minimal viable toolkit is a script on `PATH` inside `devbox`:

```
webcheck <url> --dom --a11y --console --network   # text to stdout, agent reads it
webcheck <url> --screenshot /tmp/shot.png         # agent then `read`s the PNG
```

Add `playwright-driver.browsers` (or plain `chromium`) to
`modules/devbox/container.nix:112`, set `PLAYWRIGHT_BROWSERS_PATH`, and the agent drives it
over bash. No plugin membership change in `modules/devbox/plugins.nix`.

Constraint: `devbox` is an nspawn container with no display. Headless Chromium is fine
(software rendering, no GPU), and canvas/WebGL renders through SwiftShader — slow but it
produces pixels, so a browser game is capturable. A *native* game is not, from inside the
container.

## Suggested order

1. **SearXNG + drop `provider = "exa"`.** Removes the only metered dependency, cheap, and
   independent of everything else. Remember `search.formats`.
2. **`webcheck` text mode** (DOM / a11y / console / network). This is where most of the
   value is and it needs no vision, no vLLM change, and no model restart.
3. **Vision on vLLM** (`2026-08-30-qwen38-agentic-settings.md` §9) plus `--screenshot`, once
   1 and 2 prove the loop is useful.

Doing 3 first would be the classic mistake: enabling a capability before the thing that feeds
it exists.

## 6. pi-superagents and superpowers: the actual relationship

`modules/devbox/plugins.nix` installs both. They are not alternatives — one is built on the
other, and the split is cleaner than it looks.

### They are designed as a pair

From `@teelicht/pi-superagents`'s README, verbatim:

> Pi agent-harness extension to support **Superpowers** workflows using subagents. The
> official Superpowers Pi package injects the Superpowers skills into every session. By
> contrast, the pi-superagents extension leaves it up to the user to decide when Superpowers
> should be used.

> Requires Superpowers v6.2+ ... `superagents.makeSuperpowersSkillsOptInOnly` defaults to
> `true`, so Superpowers runs only through `/sp-*` or `/skill:*`.

Our live `~/.pi/agent/extensions/subagent/config.json` confirms
`makeSuperpowersSkillsOptInOnly: true`. So pi-superagents' *reason to exist* is partly to
make superpowers opt-in rather than always-on.

### Where the dependency actually bites

It is not uniform across the agents. Checking the frontmatter of all nine:

| Agent | Kind | Skills it names |
|---|---|---|
| `sp-implement` | entrypoint | `entrySkill: using-superpowers`; `verification-before-completion, receiving-code-review, finishing-a-development-branch` |
| `sp-plan` | entrypoint | `entrySkill: writing-plans` |
| `sp-brainstorm` | entrypoint | `entrySkill: brainstorming` |
| `sp-debug` | worker | `systematic-debugging` |
| `sp-implementer` | worker | **none** |
| `sp-recon` | worker | **none** |
| `sp-research` | worker | **none** |
| `sp-review` | worker | **none** |
| `sp-implement-parallel` | entrypoint | (inherits `sp-implement` shape) |

So the package is really two layers:

- **Workflow entrypoints** — thin shells whose entire method *is* a superpowers skill. Remove
  superpowers and `/sp-plan` has nothing to inject. This is where "Requires Superpowers v6.2+"
  is literal.
- **A generic subagent runtime** — model tiers, bounded concurrency, worktree isolation,
  `session-mode: lineage-only`, depth guards. Four of the five worker agents reference no
  skill at all and are self-contained briefs.

**Answer to "can I run it without the skills": the runtime yes, the workflows no** — and the
runtime is worth far more standalone than a first read suggests. See the next section.

### The cost of skills is much lower than it looks

pi injects a **manifest only**, not skill bodies (`dist/core/skills.js:257-278`):

```
<available_skills>
  <skill><name>..</name><description>..</description><location>..</location></skill>
```

with the instruction *"Use the read tool to load a skill's file when the task matches its
description."* Superpowers' 14 `SKILL.md` files total 138,578 bytes (~35k tokens), but the
always-resident cost is only name + description + path per skill — call it 1.5-2.5k tokens.
Bodies arrive later as `read` tool results, which are **append-only and therefore
cache-friendly** (§2a of the settings doc).

That reframes the opt-in setting: the reason to keep `makeSuperpowersSkillsOptInOnly: true`
is focus and tiering, not token cost. The always-on alternative is not expensive.

One thing worth verifying empirically: if invoking `/skill:*` mid-session changes the
manifest, it changes the system block and **invalidates the prefix cache for that session**.
If `/sp-*` starts a fresh agent session instead, there is nothing to invalidate. Check which
before assuming.

### Correction to the settings doc's prefix-sharing claim

`2026-08-30-qwen38-agentic-settings.md` §11-12 assume parallel subagents share a system
prompt and tool list. That holds **only for same-role fan-outs**. Effective tool sets differ
per role — the bundled default is `["read", "grep", "find", "ls"]` and agents add to it:

| Agent | Effective tools |
|---|---|
| `sp-implementer` | defaults + `bash, write` |
| `sp-debug` | defaults + `bash` |
| `sp-recon`, `sp-research`, `sp-review` | defaults only |

Different `<tools>` blocks mean different system prefixes and **no cache sharing across
roles**. The good news is that the case that matters is the same-role one:
`sp-implement-parallel` fans out N identical `sp-implementer` instances, whose system blocks
are byte-identical, so the dedup benefit holds exactly where the concurrency is.

### The finding worth acting on: `sp-research` cannot research

`superagents.extensions` is `null` in our live config, and per the README *"Subagents run
with implicit Pi extension discovery disabled by default."* So **no subagent has
`pi-web-access`** — not even `sp-research`, whose entire description is "research specialist
for focused evidence gathering." Its frontmatter declares no tools, so it inherits
`read, grep, find, ls` and can only search the local repo.

This directly undercuts §1-2 of this document: standing up SearXNG for unlimited search does
nothing for the subagent that would benefit most until:

```json
{ "superagents": { "extensions": ["npm:pi-web-access"] } }
```

That setting is seeded from `modules/pi-coding-agent/settings.nix`'s `superagents` block, so
it is a one-line nix change — and it should be scoped deliberately rather than globally,
since giving `sp-implementer` web access is a different risk conversation than giving it to
`sp-research`.

### Is there a better way?

Realistically, no — the current pairing is well matched to a single dev on a local model, and
the alternatives are worse:

- **Superpowers alone (official pi package)** — skills always on, but no model tiers, no
  per-role context budgets, no bounded fan-out, no worktree isolation. We would lose the
  mechanism that puts subagents on the smaller alias at all.
- **pi-superagents alone** — see above; runtime without workflow.
- **Hand-rolled agents** — pi supports skills and agent files natively, so it is possible.
  It is also re-implementing pi-superagents with less iteration behind it.

The stack is not the problem. The two things worth changing are `superagents.extensions`
(above) and the window sizing in the settings doc §11.

## 7. If superpowers went away, is pi-superagents still worth keeping?

**Yes, and this corrects §6's first pass.** Checked against pi 0.84.2's own dist:

### pi has no native subagent mechanism at all

- pi's built-in tools are `read`, `bash`, `write`, `grep`, `find`, `ls`, `edit`. There is no
  `task`, `delegate`, `dispatch`, or `subagent` tool.
- `dist/extensions/` contains exactly one built-in extension (`llama`).
- The frontmatter keys the sp-* agents rely on — `maxSubagentDepth`, `session-mode`,
  `entrySkill` — do not appear anywhere in pi's dist. pi does not parse them.
- pi natively supports **skills** (`dist/core/skills.js`) and slash commands. It does not
  natively support delegating work to another agent.

So pi-superagents is not a convenience layer over a pi feature. It **is** the delegation
engine, and without it the stack has no fan-out, no parallel workers, and no way to put
subagents on a different model or context budget.

### The delegation is a tool, not a workflow entrypoint

`src/extension/index.ts:455` registers it unconditionally:

```
name: "subagent"
description: Delegate bounded work to Superpowers role subagents.
  Supports synchronous single, parallel, and forked-context dispatch...
  SINGLE:   { agent: "sp-recon", task: "Inspect the auth flow" }
  PARALLEL: { tasks: [{ agent: "sp-research", ... }, { agent: "sp-review", ... }] }
  Allowed role agents: sp-recon, sp-research, sp-implementer, sp-review, sp-debug.
```

Any agent that has the tool can call it — it is not reachable only from `/sp-*`. And four of
the five allowed roles (`sp-recon`, `sp-research`, `sp-implementer`, `sp-review`) reference no
superpowers skill whatsoever. §6's "delegation engine with nothing to delegate" was wrong:
there are four self-contained workers plus anything we write.

### What survives, and what does not

| Kept without superpowers | Lost |
|---|---|
| the `subagent` tool (single / parallel / forked) | `/sp-brainstorm`, `/sp-plan`, `/sp-implement`, `/sp-implement-parallel` — hollow without their `entrySkill` |
| `sp-recon`, `sp-research`, `sp-implementer`, `sp-review` | `sp-debug`'s method (`systematic-debugging`) |
| model tiers — the only mechanism putting subagents on the smaller alias | the workflow itself: spec -> plan -> task -> review |
| bounded 4-wide concurrency, worktree isolation, depth guards | |
| `/sp-settings` TUI | |

### The real catch

The tool's own description says:

> Use this tool only inside a Superpowers workflow when selected skills call for delegation.

That is a **prompt instruction, not an enforcement gate** — but it is the instruction the
model reads. Strip superpowers and the model is told to use delegation only inside a workflow
that no longer exists, so it will tend not to delegate at all.

So the honest shape of "drop superpowers, keep sp agents" is: we keep a capability pi does not
otherwise have, and we take on writing the *when to delegate* instructions ourselves. pi
supports skills natively, so that is one `SKILL.md` of our own — genuinely small next to
superpowers' 14 skills and 138 KB, but not zero, and it is exactly the piece superpowers is
good at.

### Verdict

Dropping superpowers to simplify is defensible; dropping pi-superagents is not, unless we are
also giving up subagents entirely. If the goal is fewer moving parts, the cheaper trim is to
keep both and stop worrying about it — `makeSuperpowersSkillsOptInOnly: true` already means
superpowers costs nothing until a `/sp-*` or `/skill:*` invocation, and the manifest-only
injection (§6) means even always-on would be ~2k tokens.

## 8. Why subagents pick the alias but not the thinking level

Observed: a delegated subagent lands on the right model alias, but the tier's `thinking`
does not apply. That is exactly what the code does. `src/execution/child-runner.ts:164`:

```ts
const launchThinking =
    extractThinkingSuffix(effectiveModel)
    ?? toThinkingLevel(agent.thinking, resolvedModel.thinking, hasModelOverride);
```

and `src/shared/thinking-levels.ts:40-43`:

```ts
export function toThinkingLevel(thinking, tierThinking, hasModelOverride) {
    if (thinking !== undefined) return thinking;              // agent frontmatter
    return hasModelOverride ? undefined : tierThinking;       // tier — DROPPED on override
}
```

**When the `subagent` tool call carries an explicit `model`, `hasModelOverride` is true and
the tier's thinking is deliberately discarded.** None of the bundled sp-* agents declare
`thinking:` in frontmatter, so `thinking` is `undefined` and the result is `undefined` — no
thinking suffix is appended to the child's `--models` argument.

### Why that is worse than it sounds

With no suffix, the child pi falls back to its own default, and
`modules/pi-coding-agent/settings.nix:70` sets:

```nix
defaultThinkingLevel = "high";
```

which `models.nix` `thinkingLevels` maps to **`xhigh`**. So an overridden subagent does not
lose thinking — it silently runs at the *most expensive* level. Four parallel `cheap`-tier
workers intended to run at `medium` all reasoning at `xhigh` is precisely the failure mode
`models.nix:57-64` warns about, and it lands on the fan-out where it costs the most.

### Three fixes, cheapest first

1. **Carry the suffix in the model string.** `extractThinkingSuffix(effectiveModel)` is
   checked *first* and wins over everything, so an override written as
   `redtruck/Qwen3.8-27B-NVFP4-48k:medium` is honoured. If we are going to override the model
   at all, always write the level into it.
2. **Do not override the model in `subagent` calls.** Let `model: cheap` in the agent
   frontmatter resolve the tier, which keeps `hasModelOverride` false and the tier's thinking
   intact. This is the intended path; the override is the exception.
3. **Declare `thinking:` in agent frontmatter.** It wins unconditionally
   (`thinking !== undefined` returns immediately), so it survives model overrides. Requires
   user-level `~/.pi/agent/agents/sp-*.md` copies that shadow the bundled agents, which means
   owning them across package updates. Only worth it if 1 and 2 prove insufficient.

**Answer to "should subagents have set thinking": yes, explicitly.** Not because the default
is absent, but because the default is `xhigh`.

## 9. Tier shape

We already have "two big and one lesser" — it is just not doing what it looks like:

| Tier | Model | Thinking | Used by |
|---|---|---|---|
| `cheap` | `-48k` alias | medium | `sp-recon`, `sp-research`, `sp-implementer` — the parallel fan-out |
| `balanced` | full | medium | **nothing** — no bundled agent references it |
| `max` | full | xhigh | `sp-review`, `sp-debug` — one at a time |

`balanced` is dead config. Two live tiers, which matches the two real populations
(settings doc §11).

Recommended shape, folding in settings doc §11's finding that prefix caching argues for
*bigger* windows because compaction is the expensive event:

| Tier | Window | Thinking | Rationale |
|---|---:|---|---|
| `cheap` | **81,920** (was 49,152) | medium | fan-out; compaction threshold moves 32,768 -> 65,536, so most subagent tasks never compact. Same-role fan-outs share a byte-identical system block, so prefix caching dedupes them (§6). |
| `max` | 110,592 (unchanged) | xhigh | review/debug run one at a time; depth is the point and KV contention is not |
| `balanced` | — | — | delete, or give it a referencing agent |

Do not add a fourth "quarter" tier: a tier only pays for itself if a distinct population uses
it, and a session is bound to one entry for life.

## 10. Other subagent plugins, or our own

The ecosystem is real — `pi-subagents` 0.60.0 (the upstream pi-superagents forked from, same
author as `pi-web-access`), plus `@gotgenes/pi-subagents`, `@nklisch/pi-subagents`,
`@nicknisi/pi-subagents`, `@tintinweb/pi-subagents`, and
`@quintinshaw/pi-dynamic-workflows`. Rolling our own is also possible, since pi supports
skills and extensions natively.

None of it changes the model or hardware story. The levers that actually govern speed are in
the settings doc: prefix caching, avoiding compaction, and real concurrency. A different
delegation plugin moves none of those.

The one thing that would justify a switch is if the `hasModelOverride` behaviour in §8 proves
unfixable through options 1 and 2 — but it is fixable, so this is not the moment.

## 11. Would a different subagent plugin give better model/thinking control? Yes.

The hypothesis checks out. Two facts settle it.

### pi has no subagent docs, but it does have the primitive

`docs/` in the pi package contains compaction, containerization, custom-provider, development,
environment-variables, extensions, images, index, json, keybindings, llama-cpp, models,
packages, prompt-templates, providers, quickstart, rpc, sdk, security. **No subagents doc**,
and `README.md` mentions "subagent" zero times — consistent with §7's finding that pi ships no
delegation tool.

What it does ship is `createAgentSession()` in the SDK (`docs/sdk.md:46`), and its options are
the point:

```typescript
const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium",   // off, minimal, low, medium, high, xhigh, max
  scopedModels: [...],
  modelRuntime,
});
```

**`thinkingLevel` is a first-class typed option, separate from the model.** That is precisely
what pi-superagents cannot express: it spawns *child pi CLI processes* and has to smuggle the
level as a `model:level` string suffix on `--models`, which is why `applyThinkingSuffix` /
`hasModelOverride` exist and why §8's silent drop is possible at all. The fragility is a
consequence of the process boundary, not a bug someone forgot to fix.

### `@gotgenes/pi-subagents` already does it right

*"A focused, in-process sub-agent core for pi — autonomous agents plus a typed API and
lifecycle events other extensions build on."* v21.0.2. **Zero mentions of superpowers in its
README.**

The contract, verbatim:

> Agent frontmatter never overrides an option you pass. It fills `model`, `thinkingLevel`, and
> `maxTurns` when you omit them; `inheritContext` is the exception, and defaults to `false`
> whatever the agent file declares.

and it **throws** when a `thinkingLevel` is not one of `off, minimal, low, medium, high, xhigh,
max`, rather than silently falling through to `defaultThinkingLevel`.

That is the exact inverse of §8's failure. Other things it has that we currently want:

| Capability | Relevance |
|---|---|
| `locked` frontmatter — *"guards against a model guessing harness settings"* | directly fixes "it picked an alias but not the thinking level": the model cannot choose its own tier |
| `inheritContext` defaults to **false** | fresh context per subagent by default — the per-WP orchestrator pattern's core requirement |
| configurable concurrency (default 4, queues the excess) | pi-superagents hardcodes `MAX_CONCURRENCY = 4` in `types.ts:480` |
| `compactionCount`, `turnCount`, `lifetimeUsage` per record | the exact metric that mattered in the spy-hunter review — 10 compactions found only by grepping a 21 MB session file |
| event bus: `subagents:completed`, `compacted`, `failed` | makes the §8 per-WP orchestrator a clean loop instead of polling |
| `maxTurns` + graceful wrap-up warning | bounds a runaway subagent with a partial result instead of a hard abort |
| in-process, no subprocess per child | no CLI string boundary; shared model catalog |
| `.pi/agents/<name>.md` custom types | same authoring model we already use |
| `@gotgenes/pi-subagents-worktrees` | worktree isolation as a composable add-on |

### What the swap costs

- **The nine `sp-*` role agents.** Four (`sp-recon`, `sp-research`, `sp-implementer`,
  `sp-review`) are short self-contained briefs — an afternoon to port. `sp-review`'s three
  scopes and `sp-debug`'s `systematic-debugging` binding need more thought.
- **The superpowers workflow entrypoints.** `/sp-brainstorm`, `/sp-plan`, `/sp-implement` go
  away. Keeping superpowers installed still gives `/skill:brainstorming` etc., but the
  entrypoints' orchestration is pi-superagents' own and does not port.
- **`/sp-settings`** → `/subagents:settings` is the equivalent, but the tier vocabulary
  (`cheap`/`balanced`/`max`) is pi-superagents'; the mapping would be re-expressed per agent.
- **A new dependency at v21.0.2**, itself a "friendly fork of `@tintinweb/pi-subagents`". The
  version number implies churn.

### Writing our own

`createAgentSession()` makes it genuinely feasible — model, thinkingLevel, system prompt,
tools, and session management are all documented SDK options. But `@gotgenes` has already
built the lifecycle, queuing, resume, steering, retention, and metrics around it. Rolling our
own is worth it only for something none of them do, and nothing in this conversation is that.

### Honest sequencing

This is a real improvement and the reasoning behind it is right. It is also **not where the
hours are**. The spy-hunter review found the cost is the 18-hour parent and a serial
dependency graph; a better subagent runtime fixes neither. What it does is make the per-WP
orchestrator easier to build correctly and kill the thinking-level papercut.

So: after the free wins (parent restart, ledger read order, SearXNG, prefix-caching
measurement), and non-destructively — install it alongside, port `sp-research` first since it
needs per-agent `extensions` for web access anyway, and compare before moving anything else.
