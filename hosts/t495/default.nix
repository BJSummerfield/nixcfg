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
        niri.enable = true;
        fuzzel.enable = true;
        swaybg.enable = true;
        polkit-gnome.enable = true;
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
      };
      cli-tools = {
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
          };
        };
      };
    };
  };
}
