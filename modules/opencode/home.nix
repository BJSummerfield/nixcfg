{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption;
  cfg = config.mine.user.opencode;
in
{
  options.mine.user.opencode = {
    enable = mkEnableOption "Enable OpenCode configuration";

    theme = mkOption {
      type = lib.types.enum [
        "system"
        "tokyonight"
        "everforest"
        "ayu"
        "catppuccin"
        "catppuccin-macchiato"
        "gruvbox"
        "kanagawa"
        "nord"
        "matrix"
        "one-dark"
      ];
      default = "system";
      description = ''
        Theme to use for OpenCode. Options: system, tokyonight, everforest, ayu,
        catppuccin, catppuccin-macchiato, gruvbox, kanagawa, nord, matrix, one-dark.
      '';
    };

    robinllm.enable = mkEnableOption "Enable RobinLLM endpoint";

    localLLM.enable = mkEnableOption "Enable local LLM endpoint";
  };

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      opencode
    ];

    xdg.configFile."opencode/opencode.json".text = ''
      {
        "$schema": "https://opencode.ai/config.json",
        "model": "robinllm/unsloth/Qwen3-Coder-Next-GGUF:Q8_0",
        "enabled_providers": ${if cfg.robinllm.enable && cfg.localLLM.enable then "[\"robinllm\", \"localllm\"]"
          else if cfg.robinllm.enable then "[\"robinllm\"]"
          else if cfg.localLLM.enable then "[\"localllm\"]"
          else "[]"},
        "provider": {
          ${lib.optionalString cfg.robinllm.enable ''"robinllm": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "RobinLLM",
            "options": {
              "baseURL": "http://84.216.57.22:8080/v1"
            },
            "models": {
              "unsloth/Qwen3-Coder-Next-GGUF:Q8_0": {}
            }
          },''}
          ${lib.optionalString cfg.localLLM.enable ''"localllm": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "LocalLLM",
            "options": {
              "baseURL": "http://127.0.0.1:8080/v1"
            },
            "models": {
              "unsloth/Qwen3-Coder-Next-GGUF:Q8_0": {}
            }
          },''}
        }
      }
    '';

    xdg.configFile."opencode/tui.json".text = ''
      {
        "$schema": "https://opencode.ai/tui.json",
        "theme": "${cfg.theme}"
      }
    '';
  };
}
