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
  # budgetModel assumes at most one alias: with two, `head` picks the
  # lexicographically first (arbitrary) - pick deliberately if a second is
  # ever added. With none, the cheap tier falls back to the full default
  # model - same served instance, so no swap, just the larger window.
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
    # bun (on PATH via extra-packages.nix), not node: node refuses
    # --experimental-strip-types in pi-superagents' postinstall.
    npmCommand = [ "bun" ];
    # Membership, not pins: the specs come from ../devbox/plugins.nix with no
    # versions or refs, so nothing here can go stale between rebuilds. pi
    # installs a missing package at startup (latest, for an unpinned spec); a
    # rebuild re-seeds these same specs and never undoes a live
    # `pi update --extensions`.
    packages = plugins.piPackages;
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
          # the model entries), 3.6 ignores the kwarg. Without a signal the 3.8
          # template defaults every request to xhigh - this block is what makes
          # pi's thinking levels actually reach vLLM.
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
          # Reasoning and the answer share max_tokens on vLLM, so pi caps
          # thinking via thinking_token_budget (clamped to leave answer room —
          # matters most for the -48k alias's 8192 maxTokens).
          supportsThinkingTokenBudget = true;
        };
        models = redtruckModels;
      };
    };
  };

  # pi-superagents tier config. The bundled defaults point cheap/balanced/max
  # at providers we don't have (opencode-go, openai), and an unpinned tier that
  # resolved to the *other* redtruck model would make llama-swap tear down the
  # loaded vllm instance mid-session - so every tier gets the session model.
  # cheap (declared by sp-recon, sp-research and sp-implementer) takes the -48k
  # llama-swap alias: same instance, smaller declared window, so parallel
  # subagents compact before the wave can thrash the KV pool (sized in
  # models.nix from the measured pool). max (sp-review, sp-debug) runs
  # one-at-a-time and keeps the full window.
  # Thinking levels flow to vLLM via the chat-template compat block above:
  # cheap is medium, not low, because the Qwen3.8 model card warns low effort
  # on multi-turn agentic tasks trades per-turn speed for retries (models.nix
  # maps pi's low/minimal to medium for the same reason). max gets xhigh for
  # review/debug depth. Each subagent session holds one constant level, so
  # vLLM prefix caching is unaffected.
  # 1.14 also reserves a "reasoning" tier name, but no bundled agent references
  # it - configure it here only when something does.
  # home.nix copies this over the file on every activation, so a /sp-settings
  # TUI edit survives only until the next rebuild - edit here instead. It is a
  # copy and not a store symlink because the extension rewrites the file at
  # startup.
  superagents = {
    superagents = {
      modelTiers = {
        cheap = {
          model = qualified budgetModel;
          thinking = "medium";
        };
        balanced = {
          model = qualified llm.default;
          thinking = "medium";
        };
        max = {
          model = qualified llm.default;
          thinking = "xhigh";
        };
      };
    };
  };

  webSearch = {
    workflow = "auto-summary";
    provider = "exa";
    curatorTimeoutSeconds = 20;
    # pi-web-access otherwise picks its own default (claude-haiku / gpt-5.3
    # codex-spark) for the summary pass. Must stay the same provider/model as
    # settings.model above - see the swap note there.
    summaryModel = qualified llm.default;
  };
}
