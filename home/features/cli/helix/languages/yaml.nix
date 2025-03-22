{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.yaml;
in
{
  options.features.cli.helix.yaml.enable = mkEnableOption "Enable yaml lsp for helix";
  config = mkIf cfg.enable {

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
}
