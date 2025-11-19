{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf optional;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.html;
in
{
  options.mine.cli-tools.helix.lsp.html = {
    enable = mkEnableOption "Enable HTML, Templates (Askama/Jinja), and HTMX support";
    enableTailwind = mkEnableOption "Enable Tailwind CSS Intellisense";
    enableHtmx = mkEnableOption "Enable HTMX attribute completion";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.helix = {

        languages.language-server = {
          s-html-lsp = {
            command = "s-html-lsp";
          };

          htmx-lsp = mkIf cfg.enableHtmx {
            command = "htmx-lsp";
          };

          tailwindcss-language-server = mkIf cfg.enableTailwind {
            command = "tailwindcss-language-server";
          };
        };

        languages.language = [{
          name = "html";

          language-servers = [ "s-html-lsp" ]
            ++ optional cfg.enableHtmx "htmx-lsp"
            ++ optional cfg.enableTailwind "tailwindcss-language-server";

          formatter = {
            command = "djlint";
            args = [ "-" "--reformat" "--indent" "2" "--profile" "jinja" ];
          };

          auto-format = true;
        }];

        extraPackages = with pkgs; [
          nodePackages.s-html-lsp
          djlint
        ]
        ++ optional cfg.enableHtmx htmx-lsp
        ++ optional cfg.enableTailwind nodePackages.tailwindcss-language-server;
      };
    };
  };
}
