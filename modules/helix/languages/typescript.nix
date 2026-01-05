{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf types optional;
  cfg = config.mine.user.helix.lsp.typescript;
in
{
  options.mine.user.helix.lsp.typescript = {
    enable = mkEnableOption "Enable typescript lsp for helix";

    formatter = mkOption {
      type = types.enum [ "biome" "prettier" ];
      default = "biome";
      description = "The formatter to use for TypeScript in Helix.";
    };
  };
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
          name = "typescript";
          language-servers = [
            { name = "typescript-language-server"; except-features = [ "format" ]; }
            "biome"
          ];
          formatter =
            if cfg.formatter == "biome" then {
              command = "biome";
              args = [ "format" "--indent-style" "space" "--stdin-file-path" "file.ts" ];
            } else {
              command = "prettier";
              args = [ "--parser" "typescript" ];
            };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        biome
        nodePackages.typescript-language-server
        typescript
      ] ++ optional (cfg.formatter == "prettier") nodePackages.prettier;
    };
  };
}
