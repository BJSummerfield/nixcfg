{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.system.steam;
in
{
  options.mine.system.steam = {
    enable = mkEnableOption "Enable Steam";
  };

  config = mkIf cfg.enable {
    programs.steam = {
      enable = true;
    };

    mine.allowedUnfree = [
      "steam"
      "steam-unwrapped"
    ];
  };
}
