{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.graphql;
in
{
  options.features.cli.helix.graphql.enable = mkEnableOption "Enable graphql lsp for helix";
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
