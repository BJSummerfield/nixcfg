# Pi config data. Model list derived from local-llm/models.nix; plugin
# membership (no versions) in devbox/plugins.nix.
let
  llm = import ../local-llm/models.nix;
  plugins = import ../devbox/plugins.nix;

  # Aliases inherit the parent's thinkingLevels: same instance, same template.
  thinkingMapOf = m: if m ? thinkingLevels then { thinkingLevelMap = m.thinkingLevels; } else { };

  # What this gates is narrower than it looks, and the difference is the whole
  # reason it is easy to conclude vision works when it half does.
  #
  # `model.input` is referenced exactly once in openai-completions.js, at the
  # tool-result branch (:1021, `if (hasImages && model.input.includes("image"))`).
  # The user-message branch has no check at all - an attached image becomes an
  # image_url part unconditionally. So:
  #
  #   attach an image yourself   -> works with `input` absent entirely
  #   a tool returns an image    -> silently dropped unless "image" is listed,
  #                                 and the model receives the literal text
  #                                 "(see attached image)" instead
  #
  # Subagents live on the second path: a child reads a screenshot with a tool,
  # so without this it gets that placeholder string and reports it cannot see
  # anything - while the parent session, where a human attaches the file, looks
  # perfectly fine. That asymmetry is the only signal that this list is stale,
  # since provider-composer defaults it to [ "text" ] (:70).
  #
  # Derived from the catalog's `vision` block so the two cannot drift.
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

    # Subagent model routing, and nothing else. Which role does what, and
    # how hard it thinks, is a per-dispatch decision the prompting agent
    # makes: `subagent { agent, model, thinking, task }` beats every
    # setting here bar the ceiling. So nix sets a guard rail and nothing
    # else - no default to argue with, no policy.
    #
    # No defaultModel. It reads like a floor and is not one: pi-subagents
    # attaches it as the agent's own `model` (modelSource.type
    # "subagents.defaultModel"), and resolveEffectiveSubagentModel takes
    # `explicitModel ?? agentModel` - so it wins on every dispatch that omits
    # `model`, for all six bundled agents, none of which pin one. Setting it
    # is therefore a standing override of the prompting agent's judgement in
    # exactly one direction, and the orchestrator can only escape it by
    # passing `model:` on every single call.
    #
    # Unset, pi-subagents falls through to inheriting the parent session's
    # in-memory model (provider/id, not the global settings default - that
    # indirection is deliberate upstream, so another open pi session cannot
    # contaminate this one's children). That is the wanted default: children
    # get the same instance and the same full window as the parent, and the
    # dispatch may still size *down* per call with a `:suffix`.
    #
    # maxThinking is a hard ceiling - a request above it fails before the
    # child starts, covering frontmatter, per-run overrides and nested
    # launches alike. No defaultThinking to go with it: it only fills
    # agents that declare no level, and of the bundled six only `delegate`
    # qualifies. models.nix maps pi's levels onto what the chat template
    # accepts, and folds low to medium there.
    #
    # agentOverrides is the exception to "no policy here", and only because
    # the alternative is worse. `outputMode: "file-only"` makes a child's
    # tool result a one-line pointer to the saved report instead of the whole
    # body (single-output.ts:293 returns just outputReference.message; the
    # default inline branch at :296 returns the body *and* appends the same
    # pointer). It is settable per dispatch, per agent frontmatter, or here -
    # but there is no global switch, so every report-producing agent has to be
    # named individually. Per-dispatch would be the purest place for it, which
    # is exactly why it needs a default: it is a per-call flag that must be set
    # on every single call to have any effect, and one forgotten call is a full
    # report pasted into the orchestrator.
    #
    # The bundled agents make this actively negative today rather than merely
    # missed. `scout` (agents/scout.md:9) and `researcher` (:9) already declare
    # `output:` but no `outputMode:`, so they take the inline branch: the full
    # report inlined, plus a pointer to a file holding a byte-identical copy.
    # Those two currently cost *more* context than an agent with no output file
    # at all. Setting the mode is what makes the file they already write a
    # substitute for the inline body instead of a duplicate of it.
    #
    # `reviewer` and `oracle` declare no `output:`, so they need the path too -
    # file-only requires one. Relative names take pi's managed artifact routing
    # (per-run, under the session's subagent-artifacts/), which is what we want:
    # no cross-run collisions, and it survives the /tmp tmpfs that wipes on
    # reboot. The orchestrator reads the pointer and range-reads the file only
    # if it needs more than the child's closing summary.
    #
    # Not `worker`. Its deliverable is the repo, not a report; its final message
    # is already short, and a pointer to a file duplicating a diff that is
    # already on disk buys nothing while costing a read to find out.
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
            # The single largest context saving available to this deployment,
            # and it is the model's switch, not pi's.
            #
            # pi re-serializes every prior thinking block into the outgoing
            # `assistant.reasoning_content` unconditionally
            # (openai-completions.ts:1316-1317, byte-identical on main at
            # v0.85.1). Qwen3.8's template then renders each one back into the
            # prompt verbatim inside <think></think>, so a session re-pays for
            # turn 3's reasoning on every turn after it. Measured on redtruck:
            # 28,000 chars of prior reasoning = +6001 prompt tokens, per prior
            # assistant turn, cumulative.
            #
            # chat_template.jinja:119 gates that render on `preserve_thinking`,
            # which is *undefined by default and therefore true*. Setting it
            # false is what Qwen's own model card says to do: historical turns
            # carry the final answer only, never the thinking.
            #
            # It is not a blanket strip, which is the reason it is safe. The
            # same conditional keeps any reasoning after `ns.last_query_index`
            # - i.e. inside the tool loop still being executed - so the
            # multi-step tool calls that pi-mono#3325 fixed by preserving
            # thinking keep their arguments instead of degrading to `{}`.
            # Verified live, historical vs in-loop: 6091 -> 86 tokens dropped,
            # 6085 -> 6085 kept.
            #
            # A literal, not a `$var`: this is a standing property of the
            # deployment, not something a per-request thinking level should
            # move. pi forwards non-object kwarg values untouched
            # (resolveChatTemplateKwargValue), so a bare `false` arrives as a
            # JSON boolean. Note pi's built-in `qwen-chat-template` thinking
            # format hardcodes this to true - we are on `chat-template` above,
            # so nothing overrides this.
            #
            # `enable_thinking = false` does NOT do this. That controls the
            # generation prefix only, and leaves history rendering untouched -
            # measured, same 6001-token delta either way.
            #
            # Upstream may yet stop the resend client-side, at which point this
            # line becomes redundant - but harmless, so it stays either way.
            preserve_thinking = false;
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
    # Every provider that needs no API key, queried in parallel and merged
    # (deduplicated by result URL). This was pinned to exa alone, whose
    # keyless endpoint is the standing "web_search rate-limited" failure -
    # and research is the one thing this stack does constantly.
    #
    # A list, not one of the two keywords, because neither does what it
    # sounds like:
    #   "auto" walks a fixed priority order and returns the *first*
    #     available provider. isExaAvailable() is hardcoded `true`, so with
    #     no keys set auto resolves to exa every time - unpinning alone
    #     changes nothing.
    #   "all" fans out, but over its own list, which explicitly excludes
    #     duckduckgo, anysearch and parallel-mcp - so it collapses back to
    #     exa too.
    # Only an explicit list reaches the other keyless providers.
    #
    # Failures are per-provider: a provider that errors becomes a "Provider
    # errors" note appended to the answer, and only an all-provider failure
    # throws. So a throttled exa thins the result set instead of blocking
    # the search - which is the whole point of listing more than one.
    #
    # Buying a key later is appending that provider's name here, plus its
    # `<name>ApiKey` in this same file.
    #
    # Note anysearch and parallel-mcp are third-party endpoints that will
    # see every query. Drop them to ["exa" "duckduckgo"] if that is not
    # wanted; the two well-known ones already give the redundancy.
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
