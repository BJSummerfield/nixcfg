{ pkgs, ... }:
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
      teamspeak-server.enable = true;
      jellyfin-server.enable = true;
      immich-server.enable = true;
      terraria-server.enable = true;
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
