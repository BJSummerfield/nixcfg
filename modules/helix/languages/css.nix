{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf optional;
  cfg = config.mine.user.helix.lsp.css;
in
{
  options.mine.user.helix.lsp.css = {
    enable = mkEnableOption "Enable CSS LSP support";
    enableTailwind = mkEnableOption "Enable Tailwind CSS intellisense for CSS files";
  };

  config = mkIf cfg.enable {
    programs.helix = {
      languages.language-server = {
        vscode-css-language-server = {
          command = "vscode-css-language-server";
          args = [ "--stdio" ];
          config = {
            provideFormatter = false;
            css = { validate = true; lint = { unknownAtRules = "ignore"; }; };
            scss = { validate = true; lint = { unknownAtRules = "ignore"; }; };
          };
        };

        tailwindcss-language-server = mkIf cfg.enableTailwind {
          command = "tailwindcss-language-server";
        };
      };

      languages.language = [{
        name = "css";

        language-servers = [ "vscode-css-language-server" "biome" ]
          ++ optional cfg.enableTailwind "tailwindcss-language-server";

        formatter = {
          command = "prettier";
          args = [ "--parser" "css" ];
        };
        auto-format = true;
      }];

      extraPackages = with pkgs; [
        nodePackages.vscode-langservers-extracted
        nodePackages.prettier
      ]
      ++ optional cfg.enableTailwind tailwindcss-language-server;
    };
  };
}
