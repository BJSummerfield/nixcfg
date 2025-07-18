{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.yaml;
in
{
  options.mine.cli-tools.helix.lsp.yaml.enable = mkEnableOption "Enable yaml lsp for helix";
  config = mkIf cfg.enable {

    home-manager.users.${user.name} = {
      programs.helix = {
        languages = {
          language = [{
            name = "yaml";
            formatter = {
              command = "prettier";
              args = [ "--stdin-filepath" "file.yaml" ];
            };
            auto-format = true;
          }];
        };
        extraPackages = with pkgs; [
          yaml-language-server
          nodePackages.prettier
        ];
      };
    };
  };
}
