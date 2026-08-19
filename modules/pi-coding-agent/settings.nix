# Pi config data. Model list derived from local-llm/models.nix.
let
  llm = import ../local-llm/models.nix;

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
    # Use bun — node refuses --experimental-strip-types in pi-superagents postinstall.
    npmCommand = [ "bun" ];
    packages = [
      "npm:pi-web-access"
      "npm:pi-token-speed"
      # Upstream superpowers straight from git, not the @weiping npm fork.
      "git:github.com/obra/superpowers"
      "npm:@teelicht/pi-superagents"
      "npm:@monotykamary/pi-tps"
    ];
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
          # Reasoning and the answer share max_tokens on vLLM, so pi caps
          # thinking via thinking_token_budget (clamped to leave answer room —
          # matters most for the -48k alias's 8192 maxTokens).
          supportsThinkingTokenBudget = true;
        };
        models = redtruckModels;
      };
      # robin - llama.cpp box at 84.216.57.22. As of 2026-08-19 it serves
      # Qwen3.8-27B GGUF (Q4_K, 27.3B params) - the same model family and
      # same unsloth chat template as redtruck's NVFP4 and jason's Q4
      # builds, so the thinking plumbing is the same (chat-template kwargs
      # and the 3.8 effort map; the template defaults to xhigh without an
      # effort signal). The old unsloth/Qwen3-Coder-30B-A3B entry is stale -
      # the box swapped to Qwen3.8 since.
      #
      # The server runs the full native context (262144), so the headroom
      # math is models.nix's with maxModelLen = 262144: contextWindow =
      # 262144 - 20480, maxTokens 32768.
      #
      # The box is shared - other users' requests share the GPU and hold the
      # 262k KV pool, so expect slow responses and "Context size has been
      # exceeded." errors when it is busy.
      robin = {
        baseUrl = "http://84.216.57.22:8080/v1";
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
            preserve_thinking = true;
          };
          supportsThinkingTokenBudget = true;
        };
        models = [
          {
            id = "Qwen3.8-27B-GGUF";
            name = "Qwen3.8 27B GGUF (robin)";
            reasoning = true;
            contextWindow = 241664;
            maxTokens = 32768;
            # The 3.8 template accepts xhigh/medium/low and raises on
            # anything else (it maps high -> xhigh itself; map eagerly so
            # every pi level lands on an accepted value).
            thinkingLevelMap = {
              minimal = "low";
              low = "low";
              medium = "medium";
              high = "xhigh";
              xhigh = "xhigh";
              max = "xhigh";
            };
          }
        ];
      };
      # jason (AMD) — llama.cpp Vulkan box at 184.15.93.212, serving
      # Qwen3.8-27B Q4_K_XL with MTP. Same model family - and same unsloth chat template
      # - as redtruck's NVFP4 build, so the thinking plumbing is the same:
      # chat-template kwargs carry enable_thinking and reasoning_effort per
      # request. llama.cpp merges request kwargs over the --chat-template-kwargs
      # server default key-by-key, so the compose's preserve_thinking=true stays
      # in effect; it is also sent per request so the entry keeps working if the
      # compose drops the flag. Without any effort signal the 3.8 template
      # defaults every request to xhigh.
      #
      # Context is pinned by the compose --ctx-size 140000 (the server reports
      # 140032 including template tokens), so the headroom math is models.nix's
      # with maxModelLen = 140000: contextWindow = 140000 - 20480, maxTokens
      # 32768.
      #
      # The box swaps models via docker compose (Qwen3.8 <-> Qwen3.6, single
      # GPU), so the served id can change out from under this entry; the other
      # model gets its own entry when a swap turns out to be permanent.
      jason = {
        baseUrl = "http://184.15.93.212:8080/v1";
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
            preserve_thinking = true;
          };
          # Thinking and the answer share max_tokens on llama.cpp just as on
          # vLLM, so pi's thinking_token_budget clamping applies here too.
          supportsThinkingTokenBudget = true;
        };
        models = [
          {
            id = "Qwen3.8-27B-MTP-Q4";
            name = "Qwen3.8 27B Q4 MTP (jason)";
            reasoning = true;
            contextWindow = 119520;
            maxTokens = 32768;
            # The 3.8 template accepts xhigh/medium/low and raises on
            # anything else (it maps high -> xhigh itself; map eagerly so
            # every pi level lands on an accepted value).
            thinkingLevelMap = {
              minimal = "low";
              low = "low";
              medium = "medium";
              high = "xhigh";
              xhigh = "xhigh";
              max = "xhigh";
            };
          }
        ];
      };
    };
  };

  # pi-superagents tier config, seeded at
  # ~/.pi/agent/extensions/subagent/config.json. The bundled defaults point
  # cheap/balanced/max at providers we don't have (opencode-go, openai), and
  # an unpinned tier that resolved to the *other* redtruck model would make
  # llama-swap tear down the loaded vllm instance mid-session - so every
  # tier gets the session model.
  # cheap (recon/research/implementer - the tiers sp-implement-parallel
  # fans out) takes the -48k llama-swap alias: same instance, smaller
  # declared window, so parallel subagents compact before the wave can
  # thrash the KV pool (sized in models.nix from the measured pool).
  # max (review/debug) runs one-at-a-time and keeps the full window.
  # Thinking levels flow to vLLM via the chat-template compat block above.
  # cheap is medium, not low: the Qwen3.8 model card warns low effort on
  # multi-turn agentic tasks (sp-implementer) trades per-turn speed for
  # retries. max gets xhigh for review/debug depth. Each subagent session
  # holds one constant level, so vLLM prefix caching is unaffected.
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
