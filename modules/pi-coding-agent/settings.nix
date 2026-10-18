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

  prompt = role: builtins.readFile ./agents/common.md + "\n" + builtins.readFile ./agents/${role}.md;

  roles = {
    planner = {
      description = "Writes the plan and task specs, the next interview round, or the issue drafts from gathered facts";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
      output = "plan.md";
    };
    scout = {
      description = "Finds facts in a repository and reports them with file and line evidence";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "medium";
      output = "scout.md";
    };
    researcher = {
      description = "Answers a question from web and primary sources with labelled evidence";
      tools = [
        "read"
        "write"
        "web_search"
        "fetch_content"
        "get_search_content"
        "source_check"
      ];
      thinking = "medium";
      output = "research.md";
    };
    synthesizer = {
      description = "Merges raw findings into one cited synthesis";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "write"
      ];
      thinking = "medium";
      output = "synthesis.md";
    };
    implementer = {
      description = "Executes one task spec in its own worktree; with a brief, prepares branches, merges and writes PR text";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "edit"
        "write"
        "contact_supervisor"
      ];
      thinking = "medium";
      output = "result.md";
      frontmatter.acceptanceRole = "writer";
    };
    reviewer = {
      description = "Reviews a diff, plan or deliverable, verdict first, and runs the check itself";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "bash"
        "write"
      ];
      thinking = "xhigh";
      output = "review.md";
    };
  };

  yaml =
    v:
    if builtins.isBool v then
      (if v then "true" else "false")
    else if builtins.isString v then
      builtins.toJSON v
    else
      toString v;

  agentFile =
    name: role:
    let
      front = {
        inherit name;
        inherit (role) description;
        systemPromptMode = "replace";
        inheritProjectContext = true;
        inheritSkills = false;
        defaultContext = "fresh";
        defaultProgress = false;
      }
      // (role.frontmatter or { });
      lines = builtins.attrValues (builtins.mapAttrs (k: v: "${k}: ${yaml v}") front);
    in
    "---\n" + builtins.concatStringsSep "\n" lines + "\n---\n\n" + prompt name;

  override = _: role: {
    inherit (role) tools thinking output;
    outputMode = "file-only";
  };
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
      agentOverrides = builtins.mapAttrs override roles // {
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
        oracle = {
          output = "oracle.md";
          outputMode = "file-only";
          thinking = "xhigh";
        };
      };
    };
  };

  agentFiles = builtins.mapAttrs agentFile roles;

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
