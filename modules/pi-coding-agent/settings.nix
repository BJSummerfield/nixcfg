let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  inputsOf = m: {
    input = [ "text" ] ++ (if m ? vision then [ "image" ] else [ ]);
  };

  narrowWindow = m: m.maxModelLen - m.headroom;
  wideWindow = m: (m.ninfer.maxContext or m.maxModelLen) - m.headroom;

  mkModel =
    { window, label }:
    id: m:
    {
      inherit id;
      name = m.displayName + label;
      inherit (m) reasoning;
      contextWindow = window m;
      inherit (m) maxTokens;
    }
    // thinkingMapOf m
    // inputsOf m;

  narrowProvider = llm.provider;
  wideProvider = "${llm.provider}-wide";

  modelsFor = variant: map (name: mkModel variant name llm.models.${name}) llm.enabled;

  mkProvider = models: {
    inherit (llm) baseUrl;
    api = "openai-completions";
    apiKey = "dummy";
    compat = {
      supportsDeveloperRole = false;
      supportsStrictMode = false;
      supportsReasoningEffort = true;
      thinkingFormat = "chat-template";
      chatTemplateKwargs = {
        enable_thinking = {
          "$var" = "thinking.enabled";
        };
        reasoning_effort = {
          "$var" = "thinking.effort";
          omitWhenOff = true;
        };
        preserve_thinking = true;
      };
      supportsThinkingTokenBudget = false;
    };
    inherit models;
  };

  qualified = provider: id: "${provider}/${id}";
in
{
  settings = {
    theme = "dark";
    tuiMode = "regular";
    extensions = [
      "-builtin:mcp"
      "-builtin:llama.cpp"
      "-builtin:codemode"
      "-builtin:tool-search"
    ];
    model = {
      provider = narrowProvider;
      model = llm.default;
    };
    defaultProvider = narrowProvider;
    defaultModel = llm.default;
    defaultThinkingLevel = "medium";
    cacheWarming = "off";
    npmCommand = [ "bun" ];
    packages = plugins.piPackages;

    compaction.reserveTokens = 20480;

    subagents = {
      defaultModel = qualified wideProvider llm.default;
      maxThinking = "xhigh";
      agentOverrides = {
        scout = {
          output = "context.md";
          outputMode = "file-only";
          thinking = "medium";
        };
        researcher = {
          output = "research.md";
          outputMode = "file-only";
          thinking = "medium";
        };
        worker = {
          output = "worker.md";
          outputMode = "file-only";
          thinking = "medium";
        };
        delegate = {
          output = "delegate.md";
          outputMode = "file-only";
          thinking = "medium";
        };
        reviewer = {
          output = "review.md";
          outputMode = "file-only";
          thinking = "xhigh";
          tools = [
            "read"
            "grep"
            "find"
            "ls"
            "bash"
            "write"
            "contact_supervisor"
          ];
          systemPrompt = builtins.readFile ./agents/reviewer.md;
        };
        oracle = {
          output = "oracle.md";
          outputMode = "file-only";
          thinking = "xhigh";
        };
      };
    };
  };

  models = {
    providers = {
      ${narrowProvider} = mkProvider (modelsFor {
        window = narrowWindow;
        label = "";
      });
      ${wideProvider} = mkProvider (modelsFor {
        window = wideWindow;
        label = " [wide]";
      });
    };
  };

  imageBudget =
    let
      m = llm.models.${llm.default};
    in
    if m ? vision then m.vision.maxImages else 0;

  webSearch = {
    workflow = "auto-summary";
    provider = [
      "exa"
      "duckduckgo"
      "anysearch"
      "parallel-mcp"
    ];
    curatorTimeoutSeconds = 20;
    summaryModel = qualified narrowProvider llm.default;
    toolActivation = "eager";
  };

  subagentConfig = {
    globalConcurrencyLimit = 3;
    toolActivation = "eager";
    disabledFeatures = [
      "agent-management"
      "watchdog"
      "panes"
      "missions"
      "lane-management"
      "external-machines"
      "usage-budgets"
      "tool-budgets"
    ];
  };
}
