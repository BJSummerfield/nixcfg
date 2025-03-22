{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.markdown;
in
{
  options.features.cli.helix.markdown.enable = mkEnableOption "Enable markdown lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language-server = {
          mpls = {
            command = "${pkgs.mpls}/bin/mpls";
            args = [ "--dark-mode" "--enable-emoji" ];
          };
        };
        language = [{
          name = "markdown";
          auto-format = true;
          language-servers = [ "marksman" "mpls" ];
        }];
      };
      extraPackages = with pkgs; [
        marksman
        mpls
      ];
    };
  };
}
