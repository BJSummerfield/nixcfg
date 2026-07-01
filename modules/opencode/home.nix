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

    localLLM = {
      enable = mkEnableOption "Enable local LLM endpoint";

      port = mkOption {
        type = lib.types.int;
        default = 8080;
        description = "Port of the local LLM server.";
      };

      model = mkOption {
        type = lib.types.str;
        default = "unsloth/Qwen3-Coder-Next-GGUF:Q8_0";
        description = "Default model to use with local LLM.";
      };
    };
  };

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      opencode
    ];

    xdg.configFile."opencode/opencode.json".text = let
      robinModel = cfg.robinllm.model;
      localModel = cfg.localLLM.model;

      providers = {
        "llama.cpp" = {
          npm = "@ai-sdk/openai-compatible";
          name = "llama.cpp";
          options.baseURL = "http://127.0.0.1:${toString cfg.localLLM.port}/v1";
          models."${localModel}" = {};
        } // lib.optionalAttrs cfg.robinllm.enable {
          name = "RobinLLM";
          options.baseURL = "http://${cfg.robinllm.ipAddress}:${toString cfg.robinllm.port}/v1";
        };
      };

      providerKeys = lib.filter (k: providers.${k} != null) (lib.attrNames providers);
    in ''
      {
        "$schema": "https://opencode.ai/config.json",
        "model": "llama.cpp/${robinModel}",
        "enabled_providers": ${builtins.concatStringsSep ", " (map (p: "\"${p}\"") providerKeys)},
        "provider": {
          ${lib.concatStringsSep ",\n" (lib.mapAttrs' (name: cfg: {
            name = "  \"${name}\"";
            value = lib.generators.toJSON {} cfg;
          }) providers)}
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
