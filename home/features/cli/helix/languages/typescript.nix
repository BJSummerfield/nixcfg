{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.typescript;
in
{
  options.features.cli.helix.typescript.enable = mkEnableOption "Enable typescript lsp for helix";
  config = mkIf cfg.enable {

    programs.helix.languages = {
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
      }];
      extraPackages = with pkgs; [
        biome
        nodePackages.typescript-language-server
        typescript
      ];
    };
  };
}
