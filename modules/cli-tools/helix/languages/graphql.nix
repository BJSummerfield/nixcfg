{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.graphql;
in
{
  options.mine.cli-tools.helix.lsp.graphql.enable = mkEnableOption "Enable graphql lsp for helix";
  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
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
  };
}
