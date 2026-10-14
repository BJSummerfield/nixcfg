{
  pkgs,
  lib,
  config,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.html;
in
{
  options.mine.user.helix.lsp.html = {
    enable = mkEnableOption "Enable HTML, Templates (Askama/Jinja), and HTMX support";
  };

  config = mkIf cfg.enable {
    programs.helix = {
      languages.language-server = {
        superhtml = {
          command = "superhtml";
          args = [ "lsp" ];
        };
      };

      languages.language = [
        {
          name = "html";

          language-servers = [ "superhtml" ];

          formatter = {
            command = "superhtml";
            args = [
              "fmt"
              "--stdin"
            ];
          };
          auto-format = true;
        }
      ];

      extraPackages = with pkgs; [
        superhtml
      ];
    };
  };
}
