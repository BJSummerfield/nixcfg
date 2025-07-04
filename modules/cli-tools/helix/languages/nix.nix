{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.nix;
in
{
  options.mine.cli-tools.helix.lsp.nix.enable = mkEnableOption "Enable nix lsp for helix";
  config = mkIf cfg.enable {

    programs.helix = {
      languages = {
        language = [{
          name = "nix";
          formatter = {
            command = "nixpkgs-fmt";
          };
          auto-format = true;
        }];
      };
      extraPackages = with pkgs; [
        nil
        nixd
        nixpkgs-fmt
      ];
    };
  };
}
