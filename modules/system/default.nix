{ lib, pkgs, ... }:
# let
# inherit (lib)
#   mkIf;
# cfg = config.mine.system;
# in
{

  imports = [
    ./shell/fish
  ];
  # config = mkIf cfg.enable {
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
    boot.initrd.luks.devices."luks-5cccbb79-6ae4-4a43-add1-9b5fa0a03e18".device = "/dev/disk/by-uuid/5cccbb79-6ae4-4a43-add1-9b5fa0a03e18";

    networking.hostName = "t495";
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
