{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.graphql;
in
{
  options.mine.user.helix.lsp.graphql.enable = mkEnableOption "Enable graphql lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language = [{
          name = "graphql";
          formatter = {
            command = "prettier";
            args = [ "--stdin-filepath" "file.graphql" ];
          };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        nodePackages.graphql-language-service-cli
        nodePackages.prettier
      ];
    };
  };
}
