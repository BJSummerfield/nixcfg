{ pkgs, ... }:
{
  imports = [ ./languages ];
  programs.helix = {
    enable = true;
    defaultEditor = true;
    settings = {
      theme = "catppuccin_mocha_transparent";
      editor = {
        line-number = "relative";
        cursorline = true;
        color-modes = true;
        mouse = false;
        end-of-line-diagnostics = "hint";
        cursor-shape = {
          normal = "block";
          insert = "bar";
          select = "underline";
        };
        indent-guides.render = true;
        inline-diagnostics.cursor-line = "hint";
      };
    };
    languages = {
      language-server = {
        rust-analyzer.config.check = {
          command = "clippy";
        };
        biome = {
          command = "biome";
          args = [ "lsp-proxy" ];
        };
        typescript-language-server.config.tsserver = {
          path = "${pkgs.typescript}/lib/node_modules/typescript/lib/tsserver.js";
        };
        mpls = {
          command = "${pkgs.mpls}/bin/mpls";
          args = [ "--dark-mode" "--enable-emoji" ];
        };
      };
      language = [
        {
          name = "markdown";
          auto-format = true;
          language-servers = [ "marksman" "mpls" ];
        }
        {
          name = "nix";
          formatter = {
            command = "nixpkgs-fmt";
          };
          auto-format = true;
        }
        {
          name = "rust";
          formatter = {
            command = "cargo fmt";
          };
          auto-format = true;
        }
        {
          name = "javascript";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          auto-format = true;
        }
        {
          name = "json";
          language-servers = [
            { name = "vscode-json-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          formatter = {
            command = "biome";
            args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.json" ];
          };
          auto-format = true;
        }
        {
          name = "jsx";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          formatter = {
            command = "biome";
            args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.jsx" ];
          };
          auto-format = true;
        }
        {
          name = "tsx";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          formatter = {
            command = "biome";
            args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.tsx" ];
          };
          auto-format = true;
        }
        {
          name = "graphql";
          formatter = {
            command = "prettier";
            args = [ "--stdin-filepath" "file.graphql" ];
          };
          auto-format = true;
        }
        {
          name = "typescript";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          formatter = {
            command = "biome";
            args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.ts" ];
          };
          auto-format = true;
        }
        {
          name = "yaml";
          language-servers = [ "yaml-language-server" ];
          formatter = {
            command = "prettier";
            args = [ "--stdin-filepath" "file.yaml" ];
          };
          auto-format = true;
        }
        {
          name = "toml";
          formatter = {
            command = "taplo";
            args = [ "fmt" "-" ];
          };
          auto-format = true;
        }
      ];
    };
    themes = {
      catppuccin_mocha_transparent = {
        "inherits" = "catppuccin_mocha";
        "ui.background" = { };
      };
    };
    extraPackages = with pkgs; [
      #bicep
      bicep-lsp
      dotnetCorePackages.dotnet_8.sdk

      #rust
      rustc
      rust-analyzer
      clippy
      cargo
      rustfmt

      #node
      nodePackages.graphql-language-service-cli
      biome
      nodePackages.prettier
      nodePackages.typescript-language-server
      typescript

      #markdown
      marksman
      mpls

      #nix
      nil
      nixd
      nixpkgs-fmt

      #yaml
      yaml-language-server

      #toml
      taplo
    ];
  };

  home.sessionVariables = {
    EDITOR = "hx";
  };
}
