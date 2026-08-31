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

  # pi-superagents tier config, seeded at
  # ~/.pi/agent/extensions/subagent/config.json. The bundled defaults point
  # cheap/balanced/max at providers we don't have (opencode-go, openai), and
  # an unpinned tier that resolved to the *other* redtruck model would make
  # llama-swap tear down the loaded vllm instance mid-session - so every
  # tier gets the session model.
  # cheap (what sp-recon, sp-research and sp-implementer declare in their
  # frontmatter) takes the -48k llama-swap alias: same instance, smaller
  # declared window, so parallel subagents compact before the wave can
  # thrash the KV pool (sized in models.nix from the measured pool).
  # max (sp-review, sp-debug) runs one-at-a-time and keeps the full window.
  # Thinking levels flow to vLLM via the chat-template compat block above.
  # cheap is medium, not low: the Qwen3.8 model card warns low effort on
  # multi-turn agentic tasks trades per-turn speed for retries - models.nix
  # maps pi's low/minimal to medium for the same reason. max gets xhigh for
  # review/debug depth. Each subagent session holds one constant level, so
  # vLLM prefix caching is unaffected.
  # 1.14 also reserves a "reasoning" tier name, but no bundled agent
  # references it - configure it here only when something does.
  # Note: home.nix copies this over the file on every activation, so a
  # /sp-settings TUI edit survives only until the next rebuild - edit here
  # instead. It is a copy and not a store symlink because the extension
  # itself rewrites the file at startup; see the comment there.
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
