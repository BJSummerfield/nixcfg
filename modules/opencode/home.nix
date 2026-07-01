{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption;
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

    robinllm = {
      enable = mkEnableOption "Enable RobinLLM endpoint";

      ipAddress = mkOption {
        type = lib.types.str;
        default = "84.216.57.22";
        description = "IP address of the RobinLLM server.";
      };

      port = mkOption {
        type = lib.types.int;
        default = 8080;
        description = "Port of the RobinLLM server.";
      };

      model = mkOption {
        type = lib.types.str;
        default = "unsloth/Qwen3-Coder-Next-GGUF:Q8_0";
        description = "Default model to use with RobinLLM.";
      };
    };
  };

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      opencode
    ];

    xdg.configFile."opencode/opencode.json".text = let
      robinModel = cfg.robinllm.model;
    in ''
      {
        "$schema": "https://opencode.ai/config.json",
        "model": "llama.cpp/${robinModel}",
        "enabled_providers": ["ollama", "llama.cpp"],
        "provider": {
          "llama.cpp": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "RobinLLM",
            "options": {
              "baseURL": "http://${cfg.robinllm.ipAddress}:${toString cfg.robinllm.port}/v1"
            },
            "models": {
              "${robinModel}": {}
            }
          },
          "ollama": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Ollama (local)",
            "options": {
              "baseURL": "http://localhost:11434/v1"
            }
          }
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
