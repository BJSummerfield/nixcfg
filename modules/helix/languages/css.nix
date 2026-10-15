{
  pkgs,
  lib,
  config,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.css;
in
{
  options.mine.user.helix.lsp.css = {
    enable = mkEnableOption "Enable CSS LSP support";
  };

  config = mkIf cfg.enable {
    programs.helix = {
      languages.language-server = {
        vscode-css-language-server = {
          command = "vscode-css-language-server";
          args = [ "--stdio" ];
          config = {
            provideFormatter = false;
            css = {
              validate = true;
              lint = {
                unknownAtRules = "ignore";
              };
            };
            scss = {
              validate = true;
              lint = {
                unknownAtRules = "ignore";
              };
            };
          };
        };
      };

      languages.language = [
        {
          name = "css";

          language-servers = [
            "vscode-css-language-server"
            "biome"
          ];

          formatter = {
            command = "prettier";
            args = [
              "--parser"
              "css"
            ];
          };
          auto-format = true;
        }
      ];

      extraPackages = with pkgs; [
        vscode-langservers-extracted
        prettier
      ];
    };
  };
}
