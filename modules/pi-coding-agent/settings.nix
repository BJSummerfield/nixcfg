# Shared pi configuration data. Consumed by home.nix (home-manager, used on

# the nixos hosts and inside their nspawn containers) and image.nix (the OCI
# image that runs pi on macOS via docker).
{
  settings = {
    theme = "dark";
    # Keep every model reference identical: llama-swap serves one model at a
    # time, so a background task (web-search curator, titles) pointed at a
    # different model than the session evicts the loaded one and stalls
    # everything for minutes while vllm swaps. Exception: the -32k entry is
    # a llama-swap alias of the same model (see local-llm/nixos.nix) -
    # requests to it hit the already-loaded instance, no swap.
    model = {
      provider = "redtruck";
      model = "Qwen3.6-27B-NVFP4";
    };
    defaultProvider = "redtruck";
    defaultModel = "Qwen3.6-27B-NVFP4";
    defaultThinkingLevel = "high";
    # bun instead of npm for pi's package installs: pi-superagents ships a
    # postinstall that runs node --experimental-strip-types on a .ts inside
    # node_modules, which node categorically refuses (crashes every npm
    # install). bun skips untrusted lifecycle scripts, and the script's only
    # fresh-install job (seeding the subagent config) is done declaratively
    # in home.nix anyway.
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
      redtruck = {
        baseUrl = "https://llm.mist-gamma.ts.net:8443/v1";
        api = "openai-completions";
        apiKey = "dummy";
        compat = {
          supportsDeveloperRole = false;
          supportsReasoningEffort = false;
        };
        models = [
          {
            id = "Qwen3.6-35B-A3B-MTP-Q4";
            name = "Qwen3.6 35B A3B (redtruck)";
            reasoning = true;
            contextWindow = 92160;
            maxTokens = 32768;
          }
          {
            id = "Qwen3.6-27B-MTP-Q4";
            name = "Qwen3.6 27B (redtruck)";
            reasoning = true;
            contextWindow = 122880;
            maxTokens = 32768;
          }
          # NVFP4 models (vLLM; need redtruck's local-llm.cuda.enable).
          # contextWindow tracks each entry's --max-model-len in
          # modules/local-llm/nixos.nix minus generation headroom; raise both
          # together.
          {
            id = "Qwen3.6-27B-NVFP4";
            name = "Qwen3.6 27B NVFP4 (redtruck)";
            reasoning = true;
            contextWindow = 122880;
            maxTokens = 32768;
          }
          # llama-swap alias for the entry above (same weights, same
          # running vllm instance - no swap). The smaller declared window
          # is a client-side budget: pi compacts subagent sessions at 32k
          # instead of letting two parallel ones outgrow the KV pool.
          {
            id = "Qwen3.6-27B-NVFP4-32k";
            name = "Qwen3.6 27B NVFP4 32k budget (redtruck)";
            reasoning = true;
            contextWindow = 32768;
            maxTokens = 8192;
          }
          {
            id = "Qwen3.6-35B-A3B-NVFP4";
            name = "Qwen3.6 35B A3B NVFP4 (redtruck)";
            reasoning = true;
            contextWindow = 28672;
            maxTokens = 8192;
          }
        ];
      };
      robin = {
        baseUrl = "http://84.216.57.22:8080/v1";
        api = "openai-completions";
        apiKey = "dummy";
        compat = {
          supportsDeveloperRole = false;
          supportsReasoningEffort = false;
        };
        models = [
          {
            id = "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF";
            name = "Qwen3 Coder 30B A3B (robin)";
            reasoning = false;
            contextWindow = 122880;
            maxTokens = 32768;
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
  # tier gets the session model. Thinking levels are omitted: the provider
  # sets supportsReasoningEffort = false, so they'd be a no-op anyway.
  # cheap (recon/research/implementer - the tiers sp-implement-parallel
  # fans out) takes the -32k llama-swap alias: same instance, smaller
  # declared window, so parallel subagents compact early instead of
  # thrashing the KV pool. max (review/debug) runs one-at-a-time and
  # keeps the full window.
  # Note: seeding this file makes it a store symlink, so the /sp-settings
  # TUI can't write it - edit here instead.
  superagents = {
    superagents = {
      modelTiers = {
        cheap.model = "redtruck/Qwen3.6-27B-NVFP4-32k";
        balanced.model = "redtruck/Qwen3.6-27B-NVFP4";
        max.model = "redtruck/Qwen3.6-27B-NVFP4";
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
    summaryModel = "redtruck/Qwen3.6-27B-NVFP4";
  };
}
