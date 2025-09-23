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
        hostName = "vm-mac";
        fonts.enable = true;
        openssh.enable = true;
      };
      desktop = {
        fuzzel.enable = true;
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
      };
      cli-tools = {
        direnv.enable = true;
        eza.enable = true;
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
        zoxide.enable = true;
      };
    };
  };
}
