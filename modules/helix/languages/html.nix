{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf optional;
  cfg = config.mine.user.helix.lsp.html;
in
{
  options.mine.user.helix.lsp.html = {
    enable = mkEnableOption "Enable HTML, Templates (Askama/Jinja), and HTMX support";
    enableTailwind = mkEnableOption "Enable Tailwind CSS Intellisense";
  };

  config = mkIf cfg.enable {
    programs.helix = {
      languages.language-server = {
        superhtml = {
          command = "superhtml";
          args = [ "lsp" ];
        };

        tailwindcss-language-server = mkIf cfg.enableTailwind {
          command = "tailwindcss-language-server";
        };
      };

      languages.language = [{
        name = "html";

        language-servers = [ "superhtml" ]
          ++ optional cfg.enableTailwind "tailwindcss-language-server";

        formatter = {
          command = "superhtml";
          args = [ "fmt" "--stdin" ];
        };
        auto-format = true;
      }];

      extraPackages = with pkgs; [
        superhtml
      ]
      ++ optional cfg.enableTailwind tailwindcss-language-server;
    };
  };
}
