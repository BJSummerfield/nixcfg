{ lib, config, pkgs, ... }:
let
  cfg = config.mine.system.local-llm;
in
{

  options.mine.system.local-llm =
    {
      enable = lib.mkEnableOption "Local LLM";


    };
  config = lib.mkIf cfg.enable {
    services.ollama = {
      enable = true;
      package = pkgs.ollama-rocm;
      environmentVariables = {
        HCC_AMDGPU_TARGET = "gfx1100";
      };

      # qwen2.5-coder:14b ~10GB of VRAM (blazing fast, leaves room for other apps)
      # qwen2.5-coder:32b ~20GB VRAM
      loadModels = [
        "qwen3.6:27b"
      ];
    };

    # 2. Enable Open-WebUI for the frontend interface
    services.open-webui = {
      enable = true;
      port = 8080;

      environment = {
        OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";
        # Disables the login screen so you can jump straight into chatting
        WEBUI_AUTH = "False";
      };
    };

    mine.allowedUnfree = [ "open-webui" ];

    environment.systemPackages = with pkgs; [
      # aichat
      amdgpu_top
    ];
  };
}

