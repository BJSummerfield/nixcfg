{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.markdown;
in
{
  options.mine.user.helix.lsp.markdown.enable = mkEnableOption "Enable markdown lsp for helix";
  config = mkIf cfg.enable {
    mine.user.mpls.expose = true;
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
          language-servers = [
            "marksman"
            "mpls"
          ];
        }];
      };

      extraPackages = with pkgs; [
        marksman
        mpls
      ];
    };
  };
}
