{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.gamescope;
in
{
  options.mine.cli-tools.gamescope.enable = mkEnableOption "Enable gamescope compositor";

  config = mkIf cfg.enable {
    programs.gamescope.enable = true;
  };
}
