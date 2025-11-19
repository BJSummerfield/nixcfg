{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf optional;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.css;
in
{
  options.mine.cli-tools.helix.lsp.css = {
    enable = mkEnableOption "Enable CSS LSP support";
    enableTailwind = mkEnableOption "Enable Tailwind CSS intellisense for CSS files";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.helix = {
        languages.language-server = {
          vscode-css-language-server = {
            command = "vscode-css-language-server";
            args = [ "--stdio" ];
          };

          tailwindcss-language-server = mkIf cfg.enableTailwind {
            command = "tailwindcss-language-server";
          };

          biome = {
            command = "biome";
            args = [ "lsp-proxy" ];
          };
        };

        languages.language = [{
          name = "css";

          language-servers = [ "vscode-css-language-server" "biome" ]
            ++ optional cfg.enableTailwind "tailwindcss-language-server";

          formatter = {
            command = "biome";
            args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.css" ];
          };

          auto-format = true;
        }];

        extraPackages = with pkgs; [
          nodePackages.vscode-langservers-extracted
          biome
        ]
        ++ optional cfg.enableTailwind nodePackages.tailwindcss-language-server;
      };
    };
  };
}
