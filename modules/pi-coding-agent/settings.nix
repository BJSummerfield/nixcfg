# Shared pi configuration data. Consumed by home.nix (home-manager, used on

# the nixos hosts and inside their nspawn containers) and image.nix (the OCI
# image that runs pi on macOS via docker).
{
  settings = {
    theme = "dark";
    # Keep every model reference identical: llama-swap serves one model at a
    # time, so a background task (web-search curator, titles) pointed at a
    # different model than the session evicts the loaded one and stalls
    # everything for minutes while vllm swaps.
    model = {
      provider = "redtruck";
      model = "Qwen3.6-27B-NVFP4";
    };
    defaultProvider = "redtruck";
    defaultModel = "Qwen3.6-27B-NVFP4";
    defaultThinkingLevel = "high";
    packages = [
      "npm:pi-web-access"
      "npm:pi-token-speed"
      "npm:@weiping/pi-superpowers"
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
            contextWindow = 114688;
            maxTokens = 32768;
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

  webSearch = {
    workflow = "auto-summary";
    provider = "exa";
    curatorTimeoutSeconds = 20;
  };
}
