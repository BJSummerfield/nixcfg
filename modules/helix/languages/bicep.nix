{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.helix.lsp.bicep;
in
{
  options.mine.user.helix.lsp.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {
    mine.user.bicep-langserver.expose = true;
    programs.helix = {
      extraPackages = with pkgs; [
        bicep-langserver
      ];
    };
  };
}
