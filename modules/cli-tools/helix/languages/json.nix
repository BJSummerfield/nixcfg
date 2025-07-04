{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.json;
in
{
  options.mine.cli-tools.helix.lsp.json.enable = mkEnableOption "Enable json lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language-server = {
          biome = {
            command = "biome";
            args = [ "lsp-proxy" ];
          };
          typescript-language-server.config.tsserver = {
            path = "${pkgs.typescript}/lib/node_modules/typescript/lib/tsserver.js";
          };
        };
        language = [{
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
        }];
      };
      extraPackages = with pkgs; [
        biome
        nodePackages.typescript-language-server
        typescript
      ];
    };
  };
}
