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

    additionalEndpoints = mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          enable = mkEnableOption "Enable this endpoint";

          baseURL = mkOption {
            type = lib.types.str;
            description = "Base URL for the endpoint (e.g., http://localhost:3000/v1)";
          };

          model = mkOption {
            type = lib.types.str;
            description = "Model to use with this endpoint.";
          };
        };
      });
      default = {};
      description = ''
        Additional endpoints to configure. Each endpoint can be enabled/disabled independently.
        Example: additionalEndpoints.my-llm = { enable = true; baseURL = "..."; model = "..."; };
      '';
    };
  };

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      opencode
    ];

    xdg.configFile."opencode/opencode.json".text = let
      robinModel = cfg.robinllm.model;
      
      robinllmProvider = lib.optionalAttrs cfg.robinllm.enable {
        "llama.cpp" = {
          npm = "@ai-sdk/openai-compatible";
          name = "RobinLLM";
          options.baseURL = "http://${cfg.robinllm.ipAddress}:${toString cfg.robinllm.port}/v1";
          models = {
            "${robinModel}" = {};
          };
        };
      };

      additionalProviders = lib.mapAttrs' (name: epCfg: {
        name = name;
        value = {
          npm = "@ai-sdk/openai-compatible";
          name = name;
          options.baseURL = epCfg.baseURL;
          models = {
            "${epCfg.model}" = {};
          };
        };
      }) (lib.filterAttrs (n: c: c.enable) cfg.additionalEndpoints);

      allProviders = robinllmProvider // additionalProviders;
      
      providerKeys = lib.attrNames allProviders;
    in ''
      {
        "$schema": "https://opencode.ai/config.json",
        "model": "llama.cpp/${robinModel}",
        "enabled_providers": ${builtins.concatStringsSep ", " (map (p: "\"${p}\"") providerKeys)},
        "provider": {
          ${lib.concatStringsSep ",\n" (lib.mapAttrs' (name: cfg: {
            name = "  \"${name}\"";
            value = lib.generators.toJSON {} cfg;
          }) allProviders)}
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
