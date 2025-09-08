{ ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ./filesystems.nix
      ../../modules
    ];

  config = {
    mine = {
      system = {
        hostName = "redtruck";
        fonts.enable = true;
        openssh.enable = true;
      };
      groupings.encoding.enable = true;
      desktop = {
        fuzzel.enable = true;
        hypridle.enable = true;
        hyprlock.enable = true;
        mako.enable = true;
        niri = {
          enable = true;
          overlay = true;
        };
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
        docker.enable = true;
        firefox.enable = true;
        keybase.enable = true;
        obs-studio.enable = true;
        printer = {
          enable = true;
          avahi = true;
        };
        steam = {
          enable = true;
          # gamescope = true;
          remotePlay = true;
        };
      };
      cli-tools = {
        direnv.enable = true;
        eza.enable = true;
        # gamescope.overlay = true;
        gh.enable = true;
        git.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
            markdown.enable = true;
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
