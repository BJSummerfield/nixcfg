# Shared pi configuration data. Consumed by home.nix (home-manager, used on
# the nixos hosts and inside their nspawn containers) and image.nix (the OCI
# image that runs pi on macOS via docker).
{
  settings = {
    theme = "dark";
    model = {
      provider = "redtruck";
      model = "Qwen3.6-35B-A3B-MTP-Q4";
    };
    defaultProvider = "redtruck";
    defaultModel = "Qwen3.6-27B-MTP-Q4";
    defaultThinkingLevel = "high";
    packages = [
      "npm:pi-web-access"
      "npm:pi-token-speed"
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
