{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.javascript;
in
{

  options.mine.cli-tools.helix.lsp.javascript.enable = mkEnableOption "Enable javascript lsp for helix";
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
