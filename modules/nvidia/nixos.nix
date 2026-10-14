{ config, lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkIf
    ;
  cfg = config.mine.system.nvidia;
in
{
  options.mine.system.nvidia = {
    enable = mkEnableOption "Enable NVIDIA GPU support (driver + CUDA)";
  };

  config = mkIf cfg.enable {
    services.xserver.videoDrivers = [ "nvidia" ];

    hardware.graphics.enable = true;

    hardware.nvidia = {
      modesetting.enable = true;
      open = true;
      powerManagement.enable = true;
    };

    boot.kernelModules = [ "nvidia-uvm" ];

    mine.allowedUnfree = [
      "nvidia-x11"
      "nvidia-settings"
      "cuda_nvml_dev"
    ];

  };
}
