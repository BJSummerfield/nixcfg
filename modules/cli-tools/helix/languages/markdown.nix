{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.markdown;
in
{
  options.mine.cli-tools.helix.lsp.markdown.enable = mkEnableOption "Enable markdown lsp for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      languages = {
        language-server = {
          mpls = {
            # command = "${pkgs.mpls}/bin/mpls";
            args = [ "--dark-mode" "--enable-emoji" ];
          };
        };
        language = [{
          name = "markdown";
          auto-format = true;
          language-servers = [ "marksman" "mpls" ];
        }];
      };
      # TODO fix this!
      extraPackages = with pkgs; [
        marksman
        # mpls
      ];
    };
  };
}
