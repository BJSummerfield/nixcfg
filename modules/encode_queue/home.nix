{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption types mkIf;
  cfg = config.mine.user.encode_queue;
in
{
  options.mine.user.encode_queue = {
    enable = mkEnableOption "Encode Queue Tool";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
