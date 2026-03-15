{ lib, config, ... }:
let
  inherit (lib) mkOption mkIf types mkMerge;
  inherit (config.mine.system) bootPartitionUuid hostName;
in
{

  options.mine.system = {
    bootPartitionUuid = mkOption {
      type = lib.types.nullOr lib.types.str;
      description = "The UUID of the encrypted root partition.";
      default = null;
    };
    hostName = mkOption {
      type = types.str;
      description = "The hostname";
    };
    externalInterface = mkOption {
      type = lib.types.nullOr lib.types.str;
      description = "External network interface for container NAT";
      default = null;
    };
    renderGroupGid = mkOption {
      type = lib.types.nullOr lib.types.int;
      description = "GID of the render group on the host for GPU passthrough";
      default = null;
    };
    monitors = mkOption {
      type = types.attrsOf (types.submodule {
        options = {
          width = mkOption { type = types.int; };
          height = mkOption { type = types.int; };
          refreshRate = mkOption { type = types.str; default = "60.000"; };
          vrr = mkOption { type = types.bool; default = false; };
          scale = mkOption { type = types.float; default = 1.0; };
        };
      });
      default = { };
    };
  };

  config = mkMerge [
    (mkIf (bootPartitionUuid != null) {
      boot.initrd.luks.devices."luks-${bootPartitionUuid}".device = "/dev/disk/by-uuid/${bootPartitionUuid}";
    })
    {
      system.stateVersion = "24.11";

      nix = {
        settings.experimental-features = [
          "nix-command"
          "flakes"
        ];
        gc = {
          automatic = true;
          options = "--delete-older-than 14d";
        };
        optimise.automatic = true;
      };
      boot.loader.systemd-boot.enable = true;
      boot.loader.efi.canTouchEfiVariables = true;
      networking.networkmanager.enable = true;
      networking.hostName = hostName;
      time.timeZone = "America/Chicago";
    }
  ];
}
