{ lib, config, ... }:
let
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    mkMerge
    ;
  cfg = config.mine.system;
  bootCfg = cfg.boot;
in
{
  options.mine.system = {
    hostName = mkOption {
      type = types.str;
      description = "The hostname";
    };

    externalInterface = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "External network interface for container NAT";
    };

    renderGroupGid = mkOption {
      type = types.nullOr types.int;
      default = null;
      description = "GID of the render group on the host for GPU passthrough";
    };

    wheelNeedsPassword = mkOption {
      type = types.bool;
      default = true;
      description = "Whether members of the wheel group must enter a password for sudo.";
    };

    autoUpgrade.enable = mkEnableOption "automatic system upgrades from the flake";

    boot = {
      mode = mkOption {
        type = types.enum [
          "systemd-boot"
          "grub-bios"
        ];
        default = "systemd-boot";
        description = ''
          Bootloader mode. "systemd-boot" (default) requires an ESP partition;
          "grub-bios" is for BIOS/legacy VMs with a BIOS boot partition (EF02).
        '';
      };

      partitionUuid = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "The UUID of the encrypted LUKS root partition.";
      };
    };
  };

  config = mkMerge [
    {
      # No assertion needed — the enum guarantees only one bootloader.

      boot.consoleLogLevel = 3;

      system.stateVersion = "26.05";

      networking.networkmanager.enable = true;
      networking.hostName = cfg.hostName;
      time.timeZone = "America/Chicago";

      security.sudo.wheelNeedsPassword = cfg.wheelNeedsPassword;
      sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

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
    }

    (mkIf cfg.autoUpgrade.enable {
      system.autoUpgrade = {
        enable = true;
        # Not main: CI fast-forwards this ref only when nix flake check is
        # green, so a broken push leaves the hosts on their last good build.
        flake = "github:BJSummerfield/nixcfg/verified";
        dates = "04:00";
        allowReboot = true;
        rebootWindow = {
          lower = "03:00";
          upper = "05:00";
        };
      };
    })

    (mkIf (bootCfg.partitionUuid != null) {
      boot.initrd.luks.devices."luks-${bootCfg.partitionUuid}".device =
        "/dev/disk/by-uuid/${bootCfg.partitionUuid}";
    })

    (mkIf (bootCfg.mode == "systemd-boot") {
      boot.loader.systemd-boot.enable = true;
      boot.loader.efi.canTouchEfiVariables = true;
    })

    (mkIf (bootCfg.mode == "grub-bios") {
      boot.loader.grub.enable = true;
    })
  ];
}
