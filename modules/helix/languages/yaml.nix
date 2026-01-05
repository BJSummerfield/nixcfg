{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.yaml;
in
{
  options.mine.user.helix.lsp.yaml.enable = mkEnableOption "Enable yaml lsp for helix";
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
