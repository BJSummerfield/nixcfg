{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.helix.lsp.bicep;
in
{
  options.mine.cli-tools.helix.lsp.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      extraPackages = with pkgs; [
        # TODO Fix This !!
        # bicep-langserver
        dotnetCorePackages.dotnet_8.sdk
      ];
    };
  };
}
