{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.rust;
in
{

  options.mine.user.helix.lsp.rust.enable = mkEnableOption "Enable Rust lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language-server = {
          rust-analyzer.config.check = {
            command = "clippy";
          };
        };
        language = [{
          name = "rust";
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        rustc
        rust-analyzer
        clippy
        cargo
        rustfmt
      ];
    };
  };
}
