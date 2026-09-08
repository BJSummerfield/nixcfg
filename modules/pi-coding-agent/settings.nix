let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  inputsOf = m: {
    input = [ "text" ] ++ (if m ? vision then [ "image" ] else [ ]);
  };

  mkModel =
    id: m:
    {
      inherit id;
      name = m.displayName;
      inherit (m) reasoning;
      contextWindow = m.maxModelLen - m.headroom;
      inherit (m) maxTokens;
    }
    // thinkingMapOf m
    // inputsOf m;

  mkAlias =
    m: id: a:
    {
      inherit id;
      name = a.displayName;
      inherit (m) reasoning;
      inherit (a) contextWindow;
      inherit (a) maxTokens;
    }
    // thinkingMapOf m
    // inputsOf m;

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
in
{
  settings = {
    theme = "dark";
    model = {
      inherit (llm) provider;
      model = llm.default;
    };
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "high";
    npmCommand = [ "bun" ];
    packages = plugins.piPackages;

    subagents = {
      maxThinking = "xhigh";
      agentOverrides = {
        scout = {
          output = "context.md";
          outputMode = "file-only";
        };
        researcher = {
          output = "research.md";
          outputMode = "file-only";
        };
        reviewer = {
          output = "review.md";
          outputMode = "file-only";
        };
        oracle = {
          output = "oracle.md";
          outputMode = "file-only";
        };
      };
    };
  };

  models = {
    providers = {
      ${llm.provider} = {
        inherit (llm) baseUrl;
        api = "openai-completions";
        apiKey = "dummy";
        compat = {
          supportsDeveloperRole = false;
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
            preserve_thinking = false;
          };
          supportsThinkingTokenBudget = false;
        };
        models = redtruckModels;
      };
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
    summaryModel = qualified llm.default;
  };
}
