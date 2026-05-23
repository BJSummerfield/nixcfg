{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
      ../../users/sumriri.nix
      ../../users/link.nix
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
      fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      jellybox.enable = true;
      niri.enable = true;
      printing.enable = true;
      steam.enable = true;
      steambox.enable = true;
      stylix.enable = true;
      tailscale = {
        enable = true;
        ssh = true;
      };
      teamspeak-client.enable = true;
    };
    users.waktu.authorizedKeys = [ "onepassword" "redtruck" "t495" ];
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password.enable = true;
        alacritty.enable = true;
        battery-notifications.enable = true;
        catppuccin.enable = true;
        firefox.enable = true;
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
        keybase.enable = true;
        mako.enable = true;
        polkit-kde.enable = true;
        swaybg.enable = true;
        swayidle.enable = true;
        swaylock.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
      home.packages = with pkgs; [
        jellyfin-tui
      ];
    };
    sumriri.mine.user.steambox.autoStart.enable = true;
    link.mine.user.steambox.autoStart.enable = true;
    jellyuser.mine.user.jellybox.autoStart.enable = true;
  };
}
