# Pi config data. Model list derived from local-llm/models.nix; plugin
# membership (no versions) in devbox/plugins.nix.
let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  # Aliases inherit the parent's thinkingLevels: same instance, same template.
  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  # Derived from the catalog's `vision` block so prompt and enforcement can't
  # drift; see docs/pi-coding-agent.md#vision-gating for the tool-vs-attach
  # asymmetry this is actually guarding against.
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
    # All models point to the same instance — llama-swap serves one model at a
    # time, so a different model evicts and stalls for minutes.
    model = {
      inherit (llm) provider;
      model = llm.default;
    };
    defaultProvider = llm.provider;
    defaultModel = llm.default;
    defaultThinkingLevel = "high";
    # What pi installs its `packages` with; bun is on PATH via
    # extra-packages.nix. Bun loads the extensions far faster than npm, which
    # mattered when each container installed them for itself. They share state
    # and load once now, so the margin is smaller than it was.
    npmCommand = [ "bun" ];
    # Membership, not pins - see ../devbox/plugins.nix for why, and for the
    # update commands. A rebuild re-seeds these specs and never undoes a live
    # `pi update --extensions`.
    packages = plugins.piPackages;

    # Subagent model routing, and nothing else - no defaultModel, no
    # defaultThinking. maxThinking is a hard ceiling, covering frontmatter,
    # per-run overrides and nested launches alike; everything else is a
    # per-dispatch decision the prompting agent makes. See
    # docs/pi-coding-agent.md#subagent-model-routing for why there is no
    # default to go with the ceiling.
    subagents = {
      maxThinking = "xhigh";
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
          # Off: vllm#44676. The budget holder counts tool-call *argument*
          # tokens as thinking, and on exhaustion force-injects </think> into
          # the middle of the JSON arguments - a corrupt tool call, not a
          # truncated answer. Reported against qwen3_coder + qwen3; we now run
          # qwen3_xml, and the fix is unverified there, so this stays off.
          # Thinking is controlled by reasoning_effort through the chat-template
          # block above instead, which cannot corrupt a call.
          supportsThinkingTokenBudget = false;
        };
        models = redtruckModels;
      };
    };
  };

  # The engine's per-prompt image budget, surfaced so AGENTS.md can state the
  # real number instead of a copy that rots. `--limit-mm-per-prompt` is built
  # from this same block in vllm-service.nix, so the prose and the launch flag
  # cannot disagree. 0 means the served model has no vision block and images
  # are refused outright.
  imageBudget =
    let
      m = llm.models.${llm.default};
    in
    if m ? vision then m.vision.maxImages else 0;

  webSearch = {
    workflow = "auto-summary";
    # Explicit list needed - "auto"/"all" both collapse to exa alone with no
    # keys set. See docs/pi-coding-agent.md#web-search-provider-list for why.
    # Buying a key later is appending that provider's name here, plus its
    # `<name>ApiKey` in this same file.
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
