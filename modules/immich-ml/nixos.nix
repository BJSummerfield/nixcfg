{ lib, config, ... }:
{
  options.mine.system.immich-ml.enable = lib.mkEnableOption "Immich Machine Learning (ROCm)";

  config = lib.mkIf config.mine.system.immich-ml.enable {
    config.mine.system.docker.enable = true;
    networking.firewall.allowedTCPPorts = [ 3003 ];
    virtualisation.oci-containers = {
      backend = "docker";
      containers.immich-machine-learning = {
        image = "ghcr.io/immich-app/immich-machine-learning:release-rocm";
        ports = [ "3003:3003" ];
        volumes = [ "immich-ml-model-cache:/cache" ];
        extraOptions = [
          "--device=/dev/dri:/dev/dri"
          "--device=/dev/kfd:/dev/kfd"
          "--group-add=video"
          "--group-add=render"
        ];
        autoStart = true;
      };
    };
  };
}
