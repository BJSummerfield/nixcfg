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
        model = "redtruck/Qwen3.6-35B-A3B-MTP-Q4";
        provider."redtruck" = {
          options.baseURL = "https://llm.mist-gamma.ts.net:8443/v1";
          models."Qwen3.6-35B-A3B-MTP-Q4" = {
            options = {
              temperature = 0.6;
              top_p = 0.95;
              top_k = 20;
              min_p = 0.0;
            };
          };
          models."Qwen3.6-27B-MTP-Q4" = {
            options = {
              temperature = 0.6;
              top_p = 0.95;
              top_k = 20;
              min_p = 0.0;
            };
          };
        };
        provider."robin" = {
          options.baseURL = "http://84.216.57.22:8080/v1";
          models."unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF" = {
            options = {
              temperature = 0.7;
              top_p = 0.8;
              top_k = 20;
              min_p = 0.0;
              repetition_penalty = 1.05;
            };
          };
        };
        enabled_providers = [ "redtruck" "robin" ];
      };
    };
  };
}
