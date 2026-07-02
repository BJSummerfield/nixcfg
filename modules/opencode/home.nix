{ lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.opencode;
  theme = "catppuccin-mocha-transparent";
in
{
  options.mine.user.opencode = {
    enable = mkEnableOption "opencode AI coding agent";
  };

  config = mkIf cfg.enable {
    programs.opencode = {
      enable = true;
      settings = {
        "$schema" = "https://opencode.ai/config.json";
        theme = theme;
        model = "robinllm/unsloth/Qwen3-Coder-Next-GGUF:Q8_0";
        provider.robinllm = {
          npm = "@ai-sdk/openai-compatible";
          name = "Robin LLM";
          options.baseURL = "http://84.216.57.22:8080/v1";
          models."unsloth/Qwen3-Coder-Next-GGUF:Q8_0" = { };
        };
        enabled_providers = [ "robinllm" ];
      };
    };
    home.file.".config/opencode/themes/${theme}.json".source = ./${theme}.json;
  };
}

