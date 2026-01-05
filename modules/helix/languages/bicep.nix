{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.bicep;
in
{
  options.mine.user.helix.lsp.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      extraPackages = with pkgs; [
        bicep-langserver
      ];
    };
    home.packages = [ pkgs.bicep-langserver ];
  };
}
