{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
      ../../users
      ../../users/waktu.nix
      ../../users/dummy.nix
    ];

  environment.systemPackages = with pkgs; [
    git
    bottom
    helix
  ];

  mine = {
    system = {
      _1password.enable = true;
      hostName = "elitebook";
      shell.fish.enable = true;
      openssh.enable = true;
      tailscale.enable = true;
      niri.enable = true;
      docker.enable = true;
      avahi.enable = true;
      printing.enable = true;
      steam.enable = true;
      gamescope.enable = true;
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        helix = {
          enable = true;
          lsp = {
            bicep.enable = true;
            css.enable = true;
            graphql.enable = true;
            html.enable = true;
            javascript.enable = true;
            json.enable = true;
            jsx.enable = true;
            nix.enable = true;
            python.enable = true;
            rust.enable = true;
            toml.enable = true;
            tsx.enable = true;
            typescript.enable = true;
            yaml.enable = true;
          };
        };
        eza.enable = true;
        _1password.enable = true;
        polkit-gnome.enable = true;
        git.enable = true;
        lazygit.enable = true;
        alacritty.enable = true;
        fuzzel.enable = true;
        firefox.enable = true;
        keybase.enable = true;
        obs-studio.enable = true;
        direnv.enable = true;
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
