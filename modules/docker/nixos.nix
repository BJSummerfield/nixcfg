{ lib, config, ... }:
{
  options.mine.system.docker.enable = lib.mkEnableOption "docker Config";

  # Saves at /var/lib/docker
  config = lib.mkIf config.mine.system.docker.enable {
    # this is a lame wrapper but there used to be more here and there
    # may be more in the future
    virtualisation.docker.enable = true;
  };
}
