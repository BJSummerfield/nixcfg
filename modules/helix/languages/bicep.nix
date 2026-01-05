{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix.lsp.bicep;
in
{
  options.mine.cli-tools.helix.lsp.bicep.enable = mkEnableOption "Enable bicep lsp for helix";
  config = mkIf cfg.enable {
    mine.cli-tools.bicep-langserver.expose = true;
    home-manager.users.${user.name} = {
      programs.helix = {
        extraPackages = with pkgs; [
          bicep-langserver
        ];
      };
    };
  };
}
