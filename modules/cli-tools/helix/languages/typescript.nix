{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.typescript;
in
{
  options.mine.cli-tools.helix.lsp.typescript.enable = mkEnableOption "Enable typescript lsp for helix";
  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
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
        };
        extraPackages = with pkgs; [
          biome
          nodePackages.typescript-language-server
          typescript
        ];
      };
    };
  };
}
