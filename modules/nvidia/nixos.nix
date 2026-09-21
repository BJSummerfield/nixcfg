{ config, lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.mine.system.nvidia;
in
{
  options.mine.system.nvidia = {
    enable = mkEnableOption "Enable NVIDIA GPU support (driver + CUDA)";
    open = mkOption {
      type = types.bool;
      default = true;
      description = "Use the open kernel modules. Requires RTX 20-series (Turing) or newer; set false for GTX 10-series and older.";
    };
  };

  config = mkIf cfg.enable {
    services.xserver.videoDrivers = [ "nvidia" ];

    hardware.graphics.enable = true;

    hardware.nvidia = {
      modesetting.enable = true;
      inherit (cfg) open;
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
