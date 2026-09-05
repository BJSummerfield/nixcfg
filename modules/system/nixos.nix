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
  # Sorted on read: ten modules append to this list, so without it the merged
  # order - and every derivation downstream of the generated iptables rules -
  # depends on modules/nixos.nix's import order. The rules match disjoint
  # interfaces and take the same action, so the sequence is not load-bearing.
  options.networking.nat.internalInterfaces = lib.mkOption {
    apply = lib.sort lib.lessThan;
  };

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

    privateCache.enable = mkEnableOption "the shared B2 binary cache as a substituter";

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

    (mkIf cfg.privateCache.enable {
      sops.secrets = {
        nix-cache-key-id = {
          sopsFile = ../../secrets/services/nix-cache-b2.yaml;
          restartUnits = [ "nix-daemon.service" ];
        };
        nix-cache-secret-key = {
          sopsFile = ../../secrets/services/nix-cache-b2.yaml;
          restartUnits = [ "nix-daemon.service" ];
        };
      };

      # Root's nix client writes the store directly and never consults the
      # daemon, so credentials must exist in every context that substitutes:
      # the daemon (non-root clients), the autoUpgrade unit, and root's AWS
      # profile file for interactive nixos-rebuild.
      sops.templates = {
        "nix-cache-b2.env" = {
          content = ''
            AWS_ACCESS_KEY_ID=${config.sops.placeholder."nix-cache-key-id"}
            AWS_SECRET_ACCESS_KEY=${config.sops.placeholder."nix-cache-secret-key"}
          '';
          restartUnits = [ "nix-daemon.service" ];
        };
        "nix-cache-b2.ini".content = ''
          [default]
          aws_access_key_id = ${config.sops.placeholder."nix-cache-key-id"}
          aws_secret_access_key = ${config.sops.placeholder."nix-cache-secret-key"}
        '';
      };

      nix.settings = {
        substituters = [
          "s3://spacefunk-nix-cache?endpoint=s3.us-east-005.backblazeb2.com&region=us-east-005"
        ];
        trusted-public-keys = [
          "spacefunk-nix-cache-1:y3hr8PFKky16X7YDVH/PUDUG4gGEtrYcthUWKL4XrA4="
        ];
      };

      systemd.services.nix-daemon.serviceConfig.EnvironmentFile =
        config.sops.templates."nix-cache-b2.env".path;

      systemd.services.nixos-upgrade = mkIf cfg.autoUpgrade.enable {
        serviceConfig.EnvironmentFile = config.sops.templates."nix-cache-b2.env".path;
      };

      # AWS's chain falls back to the profile file, which covers direct-store
      # root builds that no EnvironmentFile can reach. Replaces any existing
      # root AWS profile: privateCache hosts must not also hold other root
      # AWS credentials.
      systemd.tmpfiles.rules = [
        "d /root/.aws 0700 root root -"
        "L+ /root/.aws/credentials - - - - ${config.sops.templates."nix-cache-b2.ini".path}"
      ];
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
