{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.rust;
in
{

  options.features.cli.helix.rust.enable = mkEnableOption "Enable Rust lsp for helix";
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
