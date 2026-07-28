{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf optionals;
  cfg = config.mine.user.pi-coding-agent;
  jsonFormat = pkgs.formats.json { };
  # pi-sandbox config. Critical: ~/.pi must be in allowRead, otherwise the
  # sandbox masks its own apply-seccomp helper (lives in ~/.pi/agent/npm)
  # and every bash command fails with exit 127.
  sandboxSettings = {
    enabled = true;
    network = {
      allowLocalBinding = true;
      # nix commands inside the sandbox need the nix-daemon unix socket
      allowAllUnixSockets = true;
      allowedDomains = [
        "localhost"
        "127.0.0.1"
        "cache.nixos.org"
        "channels.nixos.org"
        "github.com"
        "*.github.com"
        "*.githubusercontent.com"
        "registry.npmjs.org"
        "*.npmjs.org"
      ];
      deniedDomains = [ ];
    };
    filesystem = {
      # Don't deny /home here: on Linux bwrap must create placeholder files
      # to mask non-existent denyWrite paths inside the cwd (.env, .gitconfig,
      # ...), and a read-only /home layer makes that fail — every bash command
      # dies with "Read-only file system". Mask sensitive dirs directly instead.
      denyRead = [
        "~/.ssh"
        "~/.gnupg"
      ];
      allowRead = [
        "."
        "/nix"
        "~/.pi"
        "~/projects"
        "~/.config"
        "~/.cache"
        "~/.local"
      ];
      allowWrite = [
        "."
        "/tmp"
        "~/.cache"
      ];
      denyWrite = [
        ".env"
        ".env.*"
        "*.pem"
        "*.key"
        "~/.ssh"
        "~/.gnupg"
      ];
    };
  };
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
    sandbox.enable = mkEnableOption "pi-sandbox (bubblewrap-based bash/filesystem/network sandboxing)";
  };
  config = mkIf cfg.enable {
    home.file = mkIf cfg.sandbox.enable {
      ".pi/agent/sandbox.json".source =
        jsonFormat.generate "pi-sandbox.json" sandboxSettings;
    };

    programs.pi-coding-agent = {
      enable = true;
      # npm is needed so pi can install npm packages like pi-web-access
      extraPackages = [
        pkgs.nodejs
      ]
      # pi-sandbox needs ripgrep (macOS/Linux), bubblewrap + socat (Linux)
      ++ optionals cfg.sandbox.enable [
        pkgs.ripgrep
        pkgs.bubblewrap
        pkgs.socat
      ];
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
        ]
        ++ optionals cfg.sandbox.enable [
          "npm:pi-sandbox"
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
