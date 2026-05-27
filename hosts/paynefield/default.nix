{ pkgs, config, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
    intel-gpu-tools
  ];

  sops.secrets.vikunja-jwt-secret = {
    sopsFile = ../../secrets/hosts/paynefield.yaml;
    mode = "0400";
  };

  environment.pathsToLink = [
    "/share/applications"
    "/share/xdg-desktop-portal"
  ];

  mine = {
    system = {
      hostName = "paynefield";
      externalInterface = "enp1s0";
      renderGroupGid = 303;
      autoUpgrade.enable = true;
      dns-server.enable = true;
      fish.enable = true;
      openssh.inbound = {
        enable = true;
        openOnExternalInterface = true;
      };
      tailscale = {
        enable = true;
        ssh = true;
      };
      jellyfin-server.enable = true;
      immich-server.enable = true;
      terraria-server.enable = true;
      vikunja-server = {
        enable = true;
        jwtSecretFile = config.sops.secrets.vikunja-jwt-secret.path;
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
