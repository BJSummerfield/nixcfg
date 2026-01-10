{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules/nixos.nix
      ../../users/waktu.nix
      ../../users/dummy.nix
      ../../users/sumriri.nix
    ];



  programs.gamescope = {
    enable = true;
    capSysNice = true;
  };
  programs.steam.gamescopeSession.enable = true;

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  mine = {
    system = {
      hostName = "elitebook";
      fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      niri.enable = true;
      openssh.enable = true;
      printing.enable = true;
      steam.enable = true;
      tailscale.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        _1password = {
          enable = true;
          sshAgent.enable = true;
          gitSigning.enable = true;
          ghPlugin.enable = true;
        };
        alacritty.enable = true;
        battery-notifications.enable = true;
        catppuccin.enable = true;
        direnv.enable = true;
        firefox.enable = true;
        fish.enable = true;
        fuzzel.enable = true;
        gh.enable = true;
        git.enable = true;
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
        lazygit.enable = true;
        mako.enable = true;
        polkit-gnome.enable = true;
        stylix.enable = true;
        swaybg.enable = true;
        swayidle.enable = true;
        swaylock.enable = true;
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
    sumriri = {
      mine.user = {
        fish.enable = true;

      };
    };
    dummy = {
      mine.user = {
        git.enable = true;
        alacritty.enable = true;
        firefox.enable = true;
      };
    };
  };
}
