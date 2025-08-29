{ ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
    ];

  config = {
    mine = {
      system = {
        hostName = "t495";
        bootPartitionUuid = "5cccbb79-6ae4-4a43-add1-9b5fa0a03e18";
        fonts.enable = true;
        openssh.enable = true;
      };
      desktop = {
        battery-notifications.enable = true;
        fuzzel.enable = true;
        hypridle.enable = true;
        hyprlock.enable = true;
        mako.enable = true;
        niri.enable = true;
        polkit-gnome.enable = true;
        swaybg.enable = true;
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
        alacritty.enable = true;
        firefox.enable = true;
        keybase.enable = true;
        printer = {
          enable = true;
          avahi = true;
        };
        steam = {
          enable = true;
          gamescope = true;
        };
      };
      cli-tools = {

        direnv.enable = true;
        eza.enable = true;
        gamescope.overlay = true;
        gh.enable = true;
        git.enable = true;
        helix = {
          enable = true;
          lsp = {
            markdown.enable = true;
            nix.enable = true;
            rust.enable = true;
          };
        };
        lazygit.enable = true;
        starship.enable = true;
        tailscale.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
