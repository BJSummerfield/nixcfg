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
          options = "--delete-older-than 30d";
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
