{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  mplsModule = config.mine.user.mpls;
  cfg = config.mine.user.helix.lsp.markdown;
in
{
  options.mine.user.helix.lsp.markdown.enable = mkEnableOption "Enable markdown lsp for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      languages = {
        language-server = {
          mpls = {
            command = "${mplsModule.package}/bin/mpls";
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

      extraPackages = [
        pkgs.marksman
        mplsModule.package
      ];
    };
  };
}
