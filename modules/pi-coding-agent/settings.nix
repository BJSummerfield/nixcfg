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

    # Subagent model routing, and nothing else. Which role does what, and
    # how hard it thinks, is a per-dispatch decision the prompting agent
    # makes: `subagent { agent, model, thinking, task }` beats every
    # setting here bar the ceiling. So nix sets a safe default and a guard
    # rail, not a policy.
    #
    # defaultModel is the budget alias - the same served instance with a
    # smaller declared window, so a child compacts before a wave can
    # thrash the KV pool. It reaches all six bundled agents, none of which
    # pin a model. Escalate per call when the work wants the full window.
    # Both ids are the same instance on purpose: pointing a child at the
    # other redtruck model would make llama-swap tear down the loaded one
    # mid-session.
    #
    # maxThinking is a hard ceiling - a request above it fails before the
    # child starts, covering frontmatter, per-run overrides and nested
    # launches alike. No defaultThinking to go with it: it only fills
    # agents that declare no level, and of the bundled six only `delegate`
    # qualifies. models.nix maps pi's levels onto what the chat template
    # accepts, and folds low to medium there.
    subagents = {
      defaultModel = qualified budgetModel;
      maxThinking = "xhigh";
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

  webSearch = {
    workflow = "auto-summary";
    # Every provider that needs no API key, queried in parallel and merged
    # (deduplicated by result URL). This was pinned to exa alone, whose
    # keyless endpoint is the standing "web_search rate-limited" failure -
    # and research is the one thing this stack does constantly.
    #
    # A list, not one of the two keywords, because neither does what it
    # sounds like:
    #   "auto" walks a fixed priority order and returns the *first*
    #     available provider. isExaAvailable() is hardcoded `true`, so with
    #     no keys set auto resolves to exa every time - unpinning alone
    #     changes nothing.
    #   "all" fans out, but over its own list, which explicitly excludes
    #     duckduckgo, anysearch and parallel-mcp - so it collapses back to
    #     exa too.
    # Only an explicit list reaches the other keyless providers.
    #
    # Failures are per-provider: a provider that errors becomes a "Provider
    # errors" note appended to the answer, and only an all-provider failure
    # throws. So a throttled exa thins the result set instead of blocking
    # the search - which is the whole point of listing more than one.
    #
    # Buying a key later is appending that provider's name here, plus its
    # `<name>ApiKey` in this same file.
    #
    # Note anysearch and parallel-mcp are third-party endpoints that will
    # see every query. Drop them to ["exa" "duckduckgo"] if that is not
    # wanted; the two well-known ones already give the redundancy.
    provider = [
      "exa"
      "duckduckgo"
      "anysearch"
      "parallel-mcp"
    ];
    curatorTimeoutSeconds = 20;
    # pi-web-access otherwise picks its own default (claude-haiku / gpt-5.3
    # codex-spark) for the summary pass. Must stay the same provider/model as
    # settings.model above - see the swap note there.
    summaryModel = qualified llm.default;
  };
}
