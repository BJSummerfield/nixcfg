{ lib, config, ... }:
{
  options.mine.system.docker.enable = lib.mkEnableOption "docker Config";

  config = lib.mkIf config.mine.system.docker.enable {
    virtualisation.docker = {
      enable = false;
      rootless = {
        enable = true;
        setSocketVariable = true;
      };
    };
  };
}
