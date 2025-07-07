{ ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
      ./filesystems.nix
    ];

  config = {
    mine = {
      system = {
        hostName = "redtruck";
        bootPartitionUuid = "360f73f5-1bf7-4111-aff0-be9b1a4dd579";
        fonts.enable = true;
        openssh.enable = true;
      };
      groupings.encoding.enable = true;
      desktop = {
        battery-notifications.enable = true;
        niri.enable = true;
        fuzzel.enable = true;
        swaybg.enable = true;
        polkit-gnome.enable = true;
        hypridle.enable = true;
        hyprlock.enable = true;
        mako.enable = true;
        theme = {
          catppuccin.enable = true;
          stylix.enable = true;
        };
      };
      apps = {
        _1password = {
          enable = true;
          sshAgent = true;
          gitSigning = true;
          ghPlugin = true;
        };
        obs-studio.enable = true;
        alacritty.enable = true;
        firefox.enable = true;
        keybase.enable = true;
        steam = {
          enable = true;
          gamescope = true;
          remotePlay = true;
        };
        printer = {
          enable = true;
          avahi = true;
        };
      };
      cli-tools = {
        encode_queue.enable = true;
        tailscale.enable = true;
        direnv.enable = true;
        eza.enable = true;
        git.enable = true;
        gh.enable = true;
        lazygit.enable = true;
        starship.enable = true;
        zoxide.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
            markdown.enable = true;
            bicep.enable = true;
          };
        };
      };
    };
  };
}
