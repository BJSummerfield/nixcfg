{ pkgs, ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./filesystems.nix
      ./extraconfig.nix
      ../../modules
      ../../users/waktu.nix
    ];


  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  mine = {
    system = {
      hostName = "redtruck";
      shell.fish.enable = true;
      _1password.enable = true;
      avahi.enable = true;
      docker.enable = true;
      gamescope.enable = true;
      makemkv.enable = true;
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
        encode_queue.enable = true;
        firefox.enable = true;
        fuzzel.enable = true;
        gh.enable = true;
        git.enable = true;
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
            markdown.enable = true;
            nix.enable = true;
            python.enable = true;
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
        obs-studio.enable = true;
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
      home.packages = with pkgs; [
        abcde
        ffmpeg
        jellyfin-tui
        picard
        subtitleedit
      ];
    };
  };
}
