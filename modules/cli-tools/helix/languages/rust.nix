{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.rust;
in
{

  options.mine.cli-tools.helix.lsp.rust.enable = mkEnableOption "Enable Rust lsp for helix";
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
          formatter = {
            command = "cargo fmt";
          };
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
