{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption types mkIf;
  cfg = config.mine.user.apps.encode_queue;
in
{
  options.mine.user.apps.encode_queue = {
    enable = mkEnableOption "Encode Queue Tool";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The encode_queue package";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
