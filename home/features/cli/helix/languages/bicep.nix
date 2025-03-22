{ pkgs, lib, config, ... }:

with lib; let
  cfg = config.features.cli.helix.bicep;
in
{
  options.features.cli.helix.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {

    programs.helix.languages = {
      extraPackages = with pkgs; [
        bicep-langserver
        dotnetCorePackages.dotnet_8.sdk
      ];
    };
  };
}
