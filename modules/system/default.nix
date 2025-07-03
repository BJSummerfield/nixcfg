{ lib, pkgs, config, ... }:
let
  inherit (config.mine.system) bootPartitionUuid;
in
{

  imports = [
    ./shell/fish
  ];

  options.mine.system.bootPartitionUuid = lib.mkOption {
    type = lib.types.str;
    description = "The UUID of the encrypted root partition.";
  };

  config = {
    system.stateVersion = "24.11";

    nix = {
      settings.experimental-features = [
        "nix-command"
        "flakes"
      ];
    };

    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = true;
    boot.initrd.luks.devices."luks-${bootPartitionUuid}".device = "/dev/disk/by-uuid/${bootPartitionUuid}";

    networking.networkmanager.enable = true;

    time.timeZone = "America/Chicago";

    services.openssh = {
      enable = true;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = false;
      };
    };

    systemd.services.sshd.wantedBy = lib.mkForce [ ];

    environment.systemPackages = with pkgs; [
      wget
      git
      helix
      bottom
      # tailscale
    ];
  };
}
