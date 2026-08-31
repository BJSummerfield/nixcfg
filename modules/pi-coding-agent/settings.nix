# Pi config data. Model list derived from local-llm/models.nix; plugin
# membership (no versions) in devbox/plugins.nix.
let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  # Aliases inherit the parent's thinkingLevels: same instance, same template.
  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  mkModel =
    id: m:
    {
      inherit id;
      name = m.displayName;
      reasoning = m.reasoning;
      contextWindow = m.maxModelLen - m.headroom;
      maxTokens = m.maxTokens;
    }
    // thinkingMapOf m;

  mkAlias =
    m: id: a:
    {
      inherit id;
      name = a.displayName;
      reasoning = m.reasoning;
      contextWindow = a.contextWindow;
      maxTokens = a.maxTokens;
    }
    // thinkingMapOf m;

  entriesFor =
    name:
    let
      m = llm.models.${name};
      aliases = m.aliases or { };
    in
    [ (mkModel name m) ]
    ++ map (aliasId: mkAlias m aliasId aliases.${aliasId}) (builtins.attrNames aliases);

  redtruckModels = builtins.concatMap entriesFor llm.enabled;

  qualified = id: "${llm.provider}/${id}";
  defaultEntry = llm.models.${llm.default};
  defaultAliases = builtins.attrNames (defaultEntry.aliases or { });
  # Assumes at most one alias: with two, `head` picks the lexicographically
  # first, which is arbitrary - pick deliberately if a second is ever added.
  # With none, the cheap tier falls back to the full default model: same
  # served instance, so no swap - it only loses the smaller declared window.
  budgetModel = if defaultAliases == [ ] then llm.default else builtins.head defaultAliases;
in
{
  settings = {
    theme = "dark";
    # All models point to the same instance — llama-swap serves one model at a
    # time, so a different model evicts and stalls for minutes.
    model = {
      provider = llm.provider;
      model = llm.default;
    };
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "high";
    # What pi installs its `packages` with; bun is on PATH via
    # extra-packages.nix. Bun, not node: node refuses
    # --experimental-strip-types in pi-superagents' postinstall.
    npmCommand = [ "bun" ];
    # Membership, not pins: the specs come from ../devbox/plugins.nix and
    # carry no versions or refs, so nothing here can go stale between
    # rebuilds. pi installs a missing package at startup (latest, for an
    # unpinned spec); floating an installed one to latest is the manual
    # `pi update --extensions` - a rebuild re-seeds these same specs and
    # never undoes a live update.
    packages = plugins.piPackages;

    # pi-subagents role tiering. This lives in pi's settings.json, not in
    # the extension's own config.json - the extension reads
    # `subagents.{defaultThinking,maxThinking,agentOverrides}` from the pi
    # settings files and only its non-role keys from
    # ~/.pi/agent/extensions/subagent/config.json (its
    # docs/configuration.md is explicit about the split).
    #
    # Three populations, not a tier vocabulary:
    #   judgement (wp, reviewer)  full window, xhigh
    #   build     (worker)        budget alias, medium
    #   recon     (researcher, scout) budget alias, medium
    # The budget alias is the same served instance with a smaller declared
    # window, so a fan-out compacts before the wave can thrash the KV pool
    # (sized in models.nix from the measured pool). Pointing any role at
    # the *other* redtruck model would make llama-swap tear down the loaded
    # vLLM instance mid-session, so every role gets the session model.
    #
    # medium, not low: the Qwen3.8 model card warns that low effort on
    # multi-turn agentic work trades per-turn speed for retries, and
    # models.nix maps pi's low/minimal to medium at the chat template for
    # the same reason.
    #
    # Overrides beat builtin frontmatter outright, which is the point here -
    # bundled `worker` and `reviewer` declare `thinking: high` and `scout`
    # declares `low`, and none of those are the level we want. For *custom*
    # agents (wp) an override only fills fields the frontmatter leaves
    # unset, which is why wp.md deliberately declares neither model nor
    # thinking.
    subagents = {
      # A declared floor and a hard ceiling, so the silent high -> xhigh
      # escalation cannot come back through a role we forget to list: pi's
      # `high` maps to xhigh at the chat template (models.nix), so a role
      # that inherits the session default would quietly run at max effort.
      # maxThinking is a guard, not the authority - models.nix's
      # thinkingLevels map stays the thing that decides what vLLM sees.
      defaultThinking = "medium";
      maxThinking = "xhigh";
      agentOverrides = {
        wp = {
          model = qualified llm.default;
          thinking = "xhigh";
        };
        reviewer = {
          model = qualified llm.default;
          thinking = "xhigh";
        };
        worker = {
          model = qualified budgetModel;
          thinking = "medium";
        };
        researcher = {
          model = qualified budgetModel;
          thinking = "medium";
        };
        scout = {
          model = qualified budgetModel;
          thinking = "medium";
        };
      };
    };
  };

  models = {
    providers = {
      ${llm.provider} = {
        baseUrl = llm.baseUrl;
        api = "openai-completions";
        apiKey = "dummy";
        compat = {
          supportsDeveloperRole = false;
          supportsReasoningEffort = true;
          # vLLM renders chat_template_kwargs into the model's jinja template;
          # Qwen3.8 consumes reasoning_effort there (via thinkingLevelMap on
          # the model entries), 3.6 ignores the kwarg. Without any signal the
          # 3.8 template defaults every request to xhigh — the whole point of
          # this block is making pi's thinking levels actually reach vLLM.
          thinkingFormat = "chat-template";
          chatTemplateKwargs = {
            enable_thinking = {
              "$var" = "thinking.enabled";
            };
            reasoning_effort = {
              "$var" = "thinking.effort";
              omitWhenOff = true;
            };
          };
          # Off: vllm#44676 is open against our exact parser pair
          # (qwen3_coder + qwen3). The budget holder counts tool-call
          # *argument* tokens as thinking, and on exhaustion force-injects
          # </think> into the middle of the JSON arguments — a corrupt tool
          # call, not a truncated answer. The reporter's differential: small
          # budget 3/4 runs corrupted, large budget 0/8, budget off 0/12.
          # Thinking is controlled by reasoning_effort through the
          # chat-template block above instead, which cannot corrupt a call.
          # Reasoning and the answer still share max_tokens on vLLM; the
          # exposure that bought is now covered by the effort level rather
          # than a hard token cap.
          supportsThinkingTokenBudget = false;
        };
        models = redtruckModels;
      };
    };
  };

  # pi-subagents' *extension* config, seeded at
  # ~/.pi/agent/extensions/subagent/config.json. Role tiering is not here -
  # it is `settings.subagents` above; this file holds the extension's own
  # non-role keys.
  #
  # maxSubagentDepth is stated rather than inherited because the whole
  # nested design is a statement about depth, and upstream's default is
  # neither documented in the field table nor stable across releases:
  #
  #   depth 0  root dispatcher   interviews, writes the ledger, then only
  #                              dispatches - never reads a diff
  #   depth 1  wp                fresh context per unit; researches,
  #                              delegates, judges, writes the ledger, dies
  #   depth 2  worker/reviewer/researcher   write code, review, fetch
  #
  # 2 is exactly that shape: a child at depth 2 is blocked from spawning,
  # so the tree cannot run away. Note the trap this replaces - `1` here (or
  # `maxSubagentDepth: 1` in wp's own frontmatter) does *not* mean "wp's
  # children may not delegate"; it hands wp itself a ceiling equal to its
  # own depth and blocks every dispatch it makes.
  #
  # home.nix copies this over the file on every activation, so a runtime
  # edit survives only until the next rebuild - edit here instead.
  subagentsConfig = {
    maxSubagentDepth = 2;
  };

  webSearch = {
    workflow = "auto-summary";
    # No `provider` pin, which leaves the default `auto`: SearXNG is tried
    # first and the rest of the chain stays as fallback. It was pinned to
    # exa, whose free tier is the standing "web_search rate-limited"
    # failure - and research is the one thing this stack does constantly.
    curatorTimeoutSeconds = 20;
    # Self-hosted, in the local-llm container (one scraper for the box, not
    # one per agent). Plain http over the tailnet, which is WireGuard the
    # whole way. searx must serve `json` in search.formats or every request
    # 403s - pi-web-access asks for format=json unconditionally.
    searxngBaseUrl = "http://llm.mist-gamma.ts.net:8888";
    # pi-web-access refuses to fetch anything that resolves into a private
    # or reserved range, and the tailnet is 100.64.0.0/10 (CGNAT) - so
    # without this the self-hosted instance above is unreachable by
    # construction and search silently falls through to the paid chain.
    # Scoped to the tailnet block only; RFC1918 stays blocked.
    ssrf.allowRanges = [ "100.64.0.0/10" ];
    # pi-web-access otherwise picks its own default (claude-haiku / gpt-5.3
    # codex-spark) for the summary pass. Must stay the same provider/model as
    # settings.model above - see the swap note there.
    summaryModel = qualified llm.default;
  };
}
