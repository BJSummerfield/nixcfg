{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.apps.docker;
in
{
  options.mine.apps.docker = {
    enable = mkEnableOption "docker Config";
  };

  config = mkIf cfg.enable {
    virtualisation.docker = {
      enable = false;
      rootless = {
        enable = true;
        setSocketVariable = true;
      };
    };
  };
}
