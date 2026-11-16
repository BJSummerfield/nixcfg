let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  inputsOf = m: {
    input = [ "text" ] ++ (if m.ninfer.vision then [ "image" ] else [ ]);
  };

  window = m: m.ninfer.maxContext - m.headroom;

  compactionReserve = 20480;

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
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "medium";
    cacheWarming = "off";
    npmCommand = [ "bun" ];
    packages = plugins.piPackages;

    compaction.reserveTokens = compactionReserve;
  };

  models = {
    providers.${llm.provider} = mkProvider modelsFor;
  };

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
}
