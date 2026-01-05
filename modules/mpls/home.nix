{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption types mkIf;
  cfg = config.mine.user.mpls;
in
{
  options.mine.user.mpls = {
    enable = mkEnableOption "Mpls markdown language server";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
