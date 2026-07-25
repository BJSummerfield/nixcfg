{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.pi-coding-agent;
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };
  config = mkIf cfg.enable {
    programs.pi-coding-agent = {
      enable = true;
      # npm is needed so pi can install npm packages like pi-web-access
      extraPackages = [ pkgs.nodejs ];
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
                contextWindow = 131072;
                maxTokens = 32768;
              }
              {
                id = "Qwen3.6-27B-MTP-Q4";
                name = "Qwen3.6 27B (redtruck)";
                reasoning = true;
                contextWindow = 96000;
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
                contextWindow = 131072;
                maxTokens = 32768;
              }
            ];
          };
        };
      };
    };
  };
}
