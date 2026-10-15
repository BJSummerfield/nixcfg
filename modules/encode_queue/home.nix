{
  pkgs,
  lib,
  config,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    ;
  cfg = config.mine.user.encode_queue;
in
{
  options.mine.user.encode_queue = {
    enable = mkEnableOption "Encode Queue Tool";
  };

  config = mkIf cfg.enable {
    home.packages = [ (pkgs.callPackage ./package.nix { }) ];
  };
}
