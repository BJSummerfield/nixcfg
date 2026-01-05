{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  bicepModule = config.mine.user.bicep-langserver;
  cfg = config.mine.user.helix.lsp.bicep;
in
{
  options.mine.user.helix.lsp.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {
    programs.helix = {
      extraPackages = [
        bicepModule.package
      ];
    };
    # home.packages = [
    #   bicepModule.package
    # ];
  };
}
