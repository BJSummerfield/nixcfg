{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.toml;
in
{
  options.mine.user.helix.lsp.toml.enable = mkEnableOption "Enable toml lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language = [{
          name = "toml";
          formatter = {
            command = "taplo";
            args = [ "fmt" "-" ];
          };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        taplo
      ];
    };
  };
}
