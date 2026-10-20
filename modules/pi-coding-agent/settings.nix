let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  inputsOf = m: {
    input = [ "text" ] ++ (if m ? vision then [ "image" ] else [ ]);
  };

  window = m: (m.ninfer.maxContext or m.maxModelLen) - m.headroom;

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

  toolNotes = {
    pi = {
      searchTool = "Search with `web_search`, several queries per call, always with `workflow: \"none\"`: raw results, no summary call. Never fetch a page.";
      pageTool = "Save the page to the page path with `save_page` and read its outline; then `grep` and read ranges of the saved file, following the reading rule above. If `save_page` reports it cannot handle the URL (a PDF, a video, a GitHub page), use `fetch_content` and page through the rest with `get_search_content`.";
    };
    claude = {
      searchTool = "Search with WebSearch, several queries as needed. Never fetch a page.";
      pageTool = "Fetch the URL with WebFetch, asking it for the passages that bear on the goal word for word, section by section; there is no saved page, so a passage's location is the heading it sits under. If a fetch returns a summary instead of the page's own words, say so in the closing line.";
    };
  };

  prompt =
    harness: role:
    let
      notes = toolNotes.${harness};
    in
    builtins.replaceStrings (map (n: "@${n}@") (builtins.attrNames notes)) (builtins.attrValues notes) (
      builtins.readFile ./agents/common.md + "\n" + builtins.readFile ./agents/${role}.md
    );

  roles = {
    planner = {
      description = "Writes the implementation plan and task specs from gathered facts, or splits a research goal into angles";
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
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "opus";
      };
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
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "sonnet";
      };
    };
    searcher = {
      description = "Finds candidate sources for one angle of a question and lists them, without reading them";
      tools = [
        "read"
        "write"
        "web_search"
      ];
      thinking = "medium";
      output = "searcher.md";
      claude = {
        tools = "Read, Write, WebSearch";
        model = "haiku";
      };
    };
    extractor = {
      description = "Reads one source and copies out what bears on the goal, verbatim, with locations";
      tools = [
        "read"
        "grep"
        "write"
        "save_page"
        "fetch_content"
        "get_search_content"
      ];
      thinking = "medium";
      output = "extractor.md";
      claude = {
        tools = "Read, Grep, Write, WebFetch";
        model = "sonnet";
      };
    };
    synthesizer = {
      description = "Merges findings into one cited document in the requested format";
      tools = [
        "read"
        "grep"
        "find"
        "ls"
        "write"
      ];
      thinking = "xhigh";
      output = "synthesis.md";
      claude = {
        tools = "Read, Grep, Glob, Write";
        model = "opus";
      };
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
      description = "Reviews a diff, plan or research deliverable, verdict first, and runs the check itself";
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
      claude = {
        tools = "Read, Grep, Glob, Bash, Write";
        model = "opus";
      };
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
    "---\n" + builtins.concatStringsSep "\n" lines + "\n---\n\n" + prompt "pi" name;

  claudeAgentFile =
    name: role:
    "---\nname: ${name}\ndescription: ${yaml role.description}\ntools: ${role.claude.tools}\nmodel: ${role.claude.model}\n---\n\n"
    + prompt "claude" name;

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
      inherit (llm) provider;
      model = llm.default;
    };
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "medium";
    cacheWarming = "off";
    npmCommand = [ "bun" ];
    packages = plugins.piPackages;

    compaction.reserveTokens = 20480;

    subagents = {
      defaultModel = qualified llm.provider llm.default;
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

  claudeAgentFiles = builtins.listToAttrs (
    builtins.concatMap (
      name:
      if roles.${name} ? claude then
        [
          {
            inherit name;
            value = claudeAgentFile name roles.${name};
          }
        ]
      else
        [ ]
    ) (builtins.attrNames roles)
  );

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
