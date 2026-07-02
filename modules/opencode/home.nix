{ lib, config, ... }:

let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.opencode;
in
{
  options.mine.user.opencode = {
    enable = mkEnableOption "opencode AI coding agent";
  };

  config = mkIf cfg.enable {
    programs.opencode = {
      enable = true;
      tui = {
        theme = "system";
      };
      settings = {
        "$schema" = "https://opencode.ai/config.json";
        model = "unsloth/Qwen3-Coder-Next-GGUF:Q8_0";
        provider."llama.cpp" = {
          options.baseURL = "http://84.216.57.22:8080/v1";
          models."unsloth/Qwen3-Coder-Next-GGUF:Q8_0" = {
            options = {
              temperature = 0.7;
              top_p = 0.8;
              top_k = 20;
              min_p = 0.0;
              repetition_penalty = 1.05;
            };
          };
        };
        enabled_providers = [ "llama.cpp" ];
      };
    };
  };
}

