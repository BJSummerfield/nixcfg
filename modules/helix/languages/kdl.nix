{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.kdl;
in
{
  options.mine.user.helix.lsp.kdl.enable = mkEnableOption "Enable kdl formatter for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      languages = {
        language = [{
          name = "kdl";
          formatter = {
            command = "kdlfmt";
            args = [ "format" "-" ];
          };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        kdlfmt
      ];
    };
  };
}
