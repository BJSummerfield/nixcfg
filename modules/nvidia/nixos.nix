{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
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
      open = cfg.open;
      powerManagement.enable = true;
    };

    # CUDA normally autoloads this via nvidia-modprobe, but containers can't
    # load host modules, so load it at boot.
    boot.kernelModules = [ "nvidia-uvm" ];

    mine.allowedUnfree = [
      "nvidia-x11"
      "nvidia-settings"
      "cuda_nvml_dev" # nvtop builds against NVML headers
    ];

    # CUDA-enabled packages are unfree and not cached on cache.nixos.org
    nix.settings = {
      substituters = [ "https://cuda-maintainers.cachix.org" ];
      trusted-public-keys = [ "cuda-maintainers.cachix.org-1:0dq3bujKpuEPMCX6U4WylrUDZ9JyUG0VpVZa7CNfq5E=" ];
      # nvcc needs several GB per compile thread; nix's defaults (max-jobs
      # auto, cores 0 = all threads) let CUDA builds OOM the machine
      max-jobs = 2;
      cores = 8;
    };
  };
}
