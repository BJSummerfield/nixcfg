{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.javascript;
in
{

  options.features.cli.helix.javascript.enable = mkEnableOption "Enable javascript lsp for helix";
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
          name = "javascript";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
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
