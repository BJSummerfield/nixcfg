let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  inputsOf = m: {
    input = [ "text" ] ++ (if m ? vision then [ "image" ] else [ ]);
  };

  window = m: (m.ninfer.maxContext or m.maxModelLen) - m.headroom;

  compactionReserve = 20480;
  defaultModel = llm.models.${llm.default};

  mkModel =
    id: m:
    {
      inherit id;
      name = m.displayName;
      inherit (m) reasoning;
      contextWindow = window m;
      inherit (m) maxTokens;
    }
    // thinkingMapOf m
    // inputsOf m;

  modelsFor = map (name: mkModel name llm.models.${name}) llm.enabled;

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
      inherit (llm) provider;
      model = llm.default;
    };
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "medium";
    cacheWarming = "off";
    npmCommand = [ "bun" ];
    packages = plugins.piPackages;

    compaction.reserveTokens = compactionReserve;

    subagents = {
      defaultModel = qualified llm.provider llm.default;
      maxThinking = "xhigh";
      agentOverrides = {
        claude-code.disabled = true;
        claude-code-writer.disabled = true;
        codex-exec.disabled = true;
        codex-exec-writer.disabled = true;
        cursor-agent.disabled = true;
        cursor-agent-writer.disabled = true;
        delegate.disabled = true;
        oracle.disabled = true;
        worker.disabled = true;
        researcher.inheritGlobalContext = true;
        evidence-auditor.inheritGlobalContext = true;
      };
    };
  };

  recipes = {
    inherit (llm) provider;
    model = llm.default;
    window = window defaultModel;
    inherit compactionReserve;
    inherit (defaultModel) maxTokens;
  };

  models = {
    providers.${llm.provider} = mkProvider modelsFor;
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
    summaryModel = qualified llm.provider llm.default;
    toolActivation = "eager";
  };

  subagentConfig = {
    globalConcurrencyLimit = 3;
    maxActiveAsyncRunsPerSession = 3;
    timeoutMs = 3600000;
    worktreeBaseDir = "/var/tmp/pi-worktrees";
    toolActivation = "eager";
    defaultSubagentContext = "fresh";
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

  valve = {
    handoffTokens = window defaultModel - compactionReserve - 32768;
  };
}
