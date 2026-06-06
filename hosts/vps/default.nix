{ pkgs, lib, config, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./disko.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
    ];

  environment.pathsToLink = [
    "/share/applications"
    "/share/xdg-desktop-portal"
  ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  sops.secrets.restic-stalwart-b2-env = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };
  sops.secrets.restic-stalwart-repo-pw = {
    sopsFile = ../../secrets/hosts/vps.yaml;
    mode = "0400";
  };

  mine = {
    system = {
      # TODO Fix this jank
      boot = {
        grub.enable = true;
        systemd-boot.enable = false;
      };
      hostName = "vps";
      autoUpgrade.enable = true;
      wheelNeedsPassword = false;
      externalInterface = "enp1s0";
      # renderGroupGid = 303;
      fish.enable = true;
      openssh.inbound = {
        enable = true;
        openOnExternalInterface = true;
      };

      stalwart-server = {
        enable = true;
        hostname = "mx1.brianjs.com";
        domains = [ "brianjs.com" ];
        acmeContact = "postmaster@brianjs.com";
        adminPasswordFile = config.sops.secrets.stalwart-admin-pw.path;
        backup = {
          b2EnvFile = config.sops.secrets.restic-stalwart-b2-env.path;
          repoPasswordFile = config.sops.secrets.restic-stalwart-repo-pw.path;
          repository = "b2:spacefunk-mail-backups:stalwart";
        };
      };
      # sudo tailscale up --advertise-tags=tag:vps --accept-dns=false
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-server = {
        enable = true;
        publicAccess = true;
        tailscaleAccess = false;
      };
    };
    users.waktu.authorizedKeys = [ "onepassword" "redtruck" "t495" ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
            toml.enable = true;
            yaml.enable = true;
          };
        };
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
