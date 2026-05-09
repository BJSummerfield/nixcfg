{ lib, config, ... }:
let
  inherit (lib) mkOption mkEnableOption mkIf types mkMerge;
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
      systemd-boot.enable = mkOption {
        type = types.bool;
        default = true;
        description = "Use systemd-boot as the bootloader.";
      };

      grub = {
        enable = mkOption {
          type = types.bool;
          default = false;
          description = "Use GRUB as the bootloader.";
        };
        efiSupport = mkOption {
          type = types.bool;
          default = false;
          description = "Whether GRUB should use EFI.";
        };
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
      assertions = [
        {
          assertion = !(bootCfg.systemd-boot.enable && bootCfg.grub.enable);
          message = "mine.system.boot: systemd-boot and grub cannot both be enabled.";
        }
      ];

      boot.consoleLogLevel = 3;

      system.stateVersion = "24.11";

      networking.networkmanager.enable = true;
      networking.hostName = cfg.hostName;
      time.timeZone = "America/Chicago";


      security.sudo.wheelNeedsPassword = cfg.wheelNeedsPassword;
      sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

      nix = {
        settings.experimental-features = [ "nix-command" "flakes" ];
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
        flake = "github:BJSummerfield/nixcfg";
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

    (mkIf bootCfg.systemd-boot.enable {
      boot.loader.systemd-boot.enable = true;
      boot.loader.efi.canTouchEfiVariables = true;
    })

    (mkIf bootCfg.grub.enable {
      boot.loader.grub = {
        enable = true;
        inherit (bootCfg.grub) efiSupport;
      };
    })
  ];
}
