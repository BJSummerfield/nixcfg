{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./disko.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
      ../../users/sumriri.nix
      ../../users/sword.nix
      ../../users/jellyuser.nix
    ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  mine = {
    system = {
      hostName = "elitebook";
      externalInterface = "wlp0s20f3";
      renderGroupGid = 303;
      autoUpgrade.enable = true;
      fish.enable = true;
      jellybox.enable = true;
      steam.enable = true;
      steambox.enable = true;
      openssh.inbound = {
        enable = true;
        openOnExternalInterface = true;
      };
      pipewire.enable = true;
      tailscale = {
        enable = true;
        ssh = true;
      };
    };
    users.waktu.authorizedKeys = [ "onepassword" "redtruck" "t495" ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        fuzzel.enable = true;
        helix = {
          enable = true;
          lsp = {
            css.enable = true;
            html.enable = true;
            javascript.enable = true;
            json.enable = true;
            jsx.enable = true;
            markdown.enable = true;
            nix.enable = true;
            rust.enable = true;
            toml.enable = true;
            tsx.enable = true;
            typescript.enable = true;
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
    sumriri.mine.user.steambox.autoStart.enable = true;
    sword.mine.user.steambox.autoStart.enable = true;
  };
}
