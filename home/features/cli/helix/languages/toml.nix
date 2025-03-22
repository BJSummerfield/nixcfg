{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.toml;
in
{
  options.features.cli.helix.toml.enable = mkEnableOption "Enable toml lsp for helix";
  config = mkIf cfg.enable {

    programs.helix.languages = {
      language = [{
        name = "toml";
        formatter = {
          command = "taplo";
          args = [ "fmt" "-" ];
        };
        auto-format = true;
      }];
      extraPackages = with pkgs; [
        taplo
      ];
    };
  };
}
