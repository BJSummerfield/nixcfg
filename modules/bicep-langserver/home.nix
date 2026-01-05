{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption types mkIf;
  cfg = config.mine.user.bicep-langserver;
in
{
  options.mine.user.bicep-langserver = {
    enable = mkEnableOption "Install Bicep language server";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
