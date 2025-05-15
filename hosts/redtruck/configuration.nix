# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{ config, pkgs, ... }:

{
  imports =
    [
      # Include the results of the hardware scan.
      ./hardware-configuration.nix
    ];

  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  boot.initrd.luks.devices."luks-360f73f5-1bf7-4111-aff0-be9b1a4dd579".device = "/dev/disk/by-uuid/360f73f5-1bf7-4111-aff0-be9b1a4dd579";
  # 
  # allows mkmkv to read optical drives
  boot.kernelModules = [ "sg" ];

  networking.hostName = "redtruck"; # Define your hostname.
  # networking.wireless.enable = true;  # Enables wireless support via wpa_supplicant.

  # Configure network proxy if necessary
  # networking.proxy.default = "http://user:password@proxy:port/";
  # networking.proxy.noProxy = "127.0.0.1,localhost,internal.domain";

  # Enable networking
  networking.networkmanager.enable = true;

  # Set your time zone.
  time.timeZone = "America/Chicago";

  # Select internationalisation properties.
  i18n.defaultLocale = "en_US.UTF-8";

  i18n.extraLocaleSettings = {
    LC_ADDRESS = "en_US.UTF-8";
    LC_IDENTIFICATION = "en_US.UTF-8";
    LC_MEASUREMENT = "en_US.UTF-8";
    LC_MONETARY = "en_US.UTF-8";
    LC_NAME = "en_US.UTF-8";
    LC_NUMERIC = "en_US.UTF-8";
    LC_PAPER = "en_US.UTF-8";
    LC_TELEPHONE = "en_US.UTF-8";
    LC_TIME = "en_US.UTF-8";
  };

  # Configure keymap in X11
  services.xserver.xkb = {
    layout = "us";
    variant = "";
  };

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # List packages installed in system profile. To search, run:
  # $ nix search wget
  environment.systemPackages = with pkgs; [
    #  vim # Do not forget to add an editor to edit configuration.nix! The Nano editor is also installed by default.
    helix
    git
    # tailscale
  ];

  programs = {
    uwsm.enable = true;
    hyprland = {
      enable = true;
      withUWSM = true;
    };
  };

  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
  };


  programs.fish.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ "waktu" ];
  };
  programs._1password.enable = true;

  # services.tailscale.enable = true;

  #needed for nfs mount
  services.rpcbind.enable = true;

  fileSystems = {
    "/home/waktu/media" = {
      device = "/dev/disk/by-uuid/f9c0acb3-2ce3-4e63-baa0-6d31cca413e1";
      fsType = "ext4";
    };
    "/home/waktu/games" = {
      device = "/dev/disk/by-uuid/ee353e06-2eb1-4df2-bc2d-22c0e8b37bd9";
      fsType = "ext4";
    };
    "/home/waktu/data1" = {
      device = "/dev/disk/by-uuid/7d4a0f34-b26e-4b40-8eb5-07707af967e6";
      fsType = "ext4";
    };
    "/home/waktu/data2" = {
      device = "/dev/disk/by-uuid/41e816f6-22c4-4230-8788-c3386f029c54";
      fsType = "ext4";
    };
    "/home/waktu/nas" = {
      device = "192.168.1.234:/volume1/data"; # NFS server and share path
      fsType = "nfs";
      options = [
        "x-systemd.automount" # Only mount when accessed
        "noauto" # Prevents blocking boot if unavailable
        "x-systemd.idle-timeout=600" # Unmount after 10 minutes of inactivity
        "nfsvers=3" # Explicitly use NFSv3 (since Synology defaults to v3)
        "soft" # Prevents hanging on network issues
        "timeo=150" # Faster timeout in case of network failure
        "retrans=2" # Retries mount requests twice before failing
      ];
    };
  };

  # Rootless docker
  # virtualisation.docker.rootless = {
  #   enable = true;
  #   setSocketVariable = true;
  # };

  # Some programs need SUID wrappers, can be configured further or are
  # started in user sessions.
  # programs.mtr.enable = true;
  # programs.gnupg.agent = {
  #   enable = true;
  #   enableSSHSupport = true;
  # };

  # List services that you want to enable:

  # Enable the OpenSSH daemon.
  # services.openssh.enable = true;

  # Open ports in the firewall.
  # networking.firewall.allowedTCPPorts = [ ... ];
  # networking.firewall.allowedUDPPorts = [ ... ];
  # Or disable the firewall altogether.
  # networking.firewall.enable = false;

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "24.11"; # Did you read the comment?

}
