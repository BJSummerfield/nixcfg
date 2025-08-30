{ lib, pkgs, config, ... }:
let
  inherit (lib) mkOption types;
  inherit (config.mine.system) bootPartitionUuid hostName;
in
{

  # TODO Fix system imports file structure
  imports = [
    ./shell/fish
    ./openssh.nix
    ./fonts.nix
    ./allowUnfree.nix
    ./polkit.nix
    ./sshAgent.nix
  ];

  options.mine.system = {
    bootPartitionUuid = mkOption {
      type = types.str;
      description = "The UUID of the encrypted root partition.";
    };
    hostName = mkOption {
      type = types.str;
      description = "The hostname";
    };
  };

  config = {
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
    boot.initrd.luks.devices."luks-${bootPartitionUuid}".device = "/dev/disk/by-uuid/${bootPartitionUuid}";

    networking.networkmanager.enable = true;
    networking.hostName = hostName;

    time.timeZone = "America/Chicago";

    environment.systemPackages = with pkgs; [
      wget
      git
      helix
      bottom
    ];
  };
}
